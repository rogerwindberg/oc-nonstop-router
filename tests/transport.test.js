import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"

const transportModule = new URL("../src/transport.js", import.meta.url)

async function loadTransport() {
  assert.ok(existsSync(transportModule), "o transporte com rotação ainda não foi implementado")
  return import(transportModule)
}

async function makeStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-transport-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: path.join(root, "oc-nonstop-router") })
  for (const id of ["one", "two"]) {
    await store.upsert({ type: "oauth", accountId: id, access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000 }, id)
  }
  return store
}

const input = "https://api.openai.com/v1/responses"
const request = () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: '{"model":"gpt-5.5","stream":true}' })

test("troca de conta ao receber 429 e repete o corpo da requisição", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const attempts = []
  const fetcher = async (req) => {
    attempts.push({ url: req.url, account: req.headers.get("ChatGPT-Account-Id"), auth: req.headers.get("authorization"), body: await req.text() })
    return attempts.length === 1 ? new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429, headers: { "Retry-After": "60" } }) : new Response("ok")
  }
  const send = createRotatingFetch(store, { fetch: fetcher })
  assert.equal(await (await send(input, request())).text(), "ok")
  assert.deepEqual(attempts.map((item) => item.account), ["one", "two"])
  assert.deepEqual(attempts.map((item) => item.auth), ["Bearer access-one", "Bearer access-two"])
  assert.ok(attempts.every((item) => item.url === "https://chatgpt.com/backend-api/codex/responses"))
  assert.equal(attempts[0].body, attempts[1].body)
  assert.ok((await store.list())[0].limitedUntil > Date.now())
})

test("aguarda o primeiro reset quando todas as contas atingem o limite", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let now = Date.now()
  const waited = []
  const accounts = []
  const fetcher = async (req) => {
    const id = req.headers.get("ChatGPT-Account-Id")
    accounts.push(id)
    if (accounts.length <= 2) return new Response("{}", { status: 429, headers: { "Retry-After": id === "one" ? "2" : "5" } })
    return new Response("retomada")
  }
  const send = createRotatingFetch(store, {
    fetch: fetcher, now: () => now,
    sleep: async (ms) => { waited.push(ms); now += ms },
  })
  assert.equal(await (await send(input, request())).text(), "retomada")
  assert.deepEqual(accounts, ["one", "two", "one"])
  assert.deepEqual(waited, [2000])
})

test("cancelar a sessão interrompe a espera por cota", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const abort = new AbortController()
  const send = createRotatingFetch(store, { fetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }) })
  const promise = send(input, { ...request(), signal: abort.signal })
  setTimeout(() => abort.abort(), 20)
  await assert.rejects(promise, { name: "AbortError" })
})

test("HTTP 403 não é tratado como limite de conta", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let attempts = 0
  const send = createRotatingFetch(store, { fetch: async () => { attempts++; return new Response("forbidden", { status: 403 }) } })
  assert.equal((await send(input, request())).status, 403)
  assert.equal(attempts, 1)
  assert.equal((await store.list())[0].limitedUntil, 0)
})

test("renova o token uma vez após HTTP 401 antes de repetir a chamada", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const used = []
  let refreshes = 0
  const send = createRotatingFetch(store, {
    fetch: async (req) => {
      used.push(req.headers.get("authorization"))
      return used.length === 1 ? new Response("unauthorized", { status: 401 }) : new Response("ok")
    },
    tokenFetch: async () => { refreshes++; return Response.json({ access_token: "renewed", refresh_token: "rotated", expires_in: 3600 }) },
  })
  assert.equal(await (await send(input, request())).text(), "ok")
  assert.deepEqual(used, ["Bearer access-one", "Bearer renewed"])
  assert.equal(refreshes, 1)
})

test("não envia token OAuth para um domínio diferente do OpenAI", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const send = createRotatingFetch(store, { fetch: async () => { throw new Error("não deveria enviar") } })
  await assert.rejects(send("https://example.com/v1/responses", request()), /domain/i)
})

test("não repete uma resposta de streaming que já começou", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let attempts = 0
  const stream = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"error","error":{"code":"usage_limit_reached"}}\n\n'
  const send = createRotatingFetch(store, { fetch: async () => { attempts++; return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }) } })
  assert.equal(await (await send(input, request())).text(), stream)
  assert.equal(attempts, 1)
})

test("quota sem reset em uma conta ainda permite tentar outra conta", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let calls = 0
  const send = createRotatingFetch(store, { fetch: async () => ++calls === 1
    ? Response.json({ error: { code: "insufficient_quota" } }, { status: 429 })
    : new Response("ok") })
  assert.equal(await (await send(input, request())).text(), "ok")
  assert.equal(calls, 2)
})

test("uma rejeição de refresh antigo não invalida um login mais novo", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const real = await makeStore(t)
  await real.update("one", (account) => { account.auth.expires = 1 })
  const store = {
    list: () => real.list(),
    async update(id, fn) {
      try { return await real.update(id, fn) } catch (error) {
        if (error.status === 401) await real.upsert({ type: "oauth", accountId: "one", access: "fresh", refresh: "fresh-refresh", expires: Date.now() + 3_600_000 })
        throw error
      }
    },
  }
  const used = []
  const send = createRotatingFetch(store, {
    tokenFetch: async () => new Response("{}", { status: 401 }),
    fetch: async (req) => { used.push(req.headers.get("authorization")); return new Response("ok") },
  })
  assert.equal(await (await send(input, request())).text(), "ok")
  assert.deepEqual(used, ["Bearer fresh"])
  assert.notEqual((await real.list())[0].invalid, true)
})

test("cancelamento retorna imediatamente durante um refresh em andamento", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.update("one", (account) => { account.auth.expires = 1 })
  let unblock
  let started
  const refreshStarted = new Promise((resolve) => { started = resolve })
  const pendingRefresh = new Promise((resolve) => { unblock = resolve })
  const abort = new AbortController()
  const send = createRotatingFetch(store, {
    tokenFetch: async () => { started(); return pendingRefresh },
    fetch: async () => new Response("ok"),
  })
  const outcome = send(input, { ...request(), signal: abort.signal }).then(() => "ok", (error) => error.name)
  await refreshStarted
  abort.abort()
  const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("pendente"), 100))])
  unblock(Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 }))
  await outcome
  assert.equal(result, "AbortError")
})
