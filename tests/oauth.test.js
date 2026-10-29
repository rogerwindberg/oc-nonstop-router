import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"

const oauthModule = new URL("../src/oauth.js", import.meta.url)

async function loadOAuth() {
  assert.ok(existsSync(oauthModule), "o fluxo OAuth ainda não foi implementado")
  return import(oauthModule)
}

async function makeStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-oauth-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return createStore({ directory: path.join(root, "oc-nonstop-router") })
}

function jwt(claims) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

test("renova apenas uma vez quando duas requisições usam o token expirado", async (t) => {
  const { refreshIfNeeded } = await loadOAuth()
  const store = await makeStore(t)
  await store.upsert({ type: "oauth", accountId: "one", access: "old", refresh: "old-refresh", expires: 1 })
  let calls = 0
  const tokenFetch = async (url, init) => {
    calls++
    assert.equal(url, "https://auth.openai.com/oauth/token")
    const body = new URLSearchParams(init.body)
    assert.equal(body.get("grant_type"), "refresh_token")
    assert.equal(body.get("refresh_token"), "old-refresh")
    await new Promise((resolve) => setTimeout(resolve, 20))
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
  }

  const [first, second] = await Promise.all([
    refreshIfNeeded(store, "one", { fetch: tokenFetch }),
    refreshIfNeeded(store, "one", { fetch: tokenFetch }),
  ])

  assert.equal(calls, 1)
  assert.equal(first.access, "new-access")
  assert.equal(second.access, "new-access")
  assert.equal((await store.list())[0].auth.refresh, "new-refresh")
})

test("não substitui credenciais quando o servidor rejeita o refresh", async (t) => {
  const { refreshIfNeeded } = await loadOAuth()
  const store = await makeStore(t)
  await store.upsert({ type: "oauth", accountId: "one", access: "old", refresh: "old-refresh", expires: 1 })
  await assert.rejects(refreshIfNeeded(store, "one", { fetch: async () => new Response("{}", { status: 401 }) }), /401/)
  assert.equal((await store.list())[0].auth.refresh, "old-refresh")
})

test("o login por dispositivo entrega as credenciais e a identidade da conta", async () => {
  const { authorizeDevice } = await loadOAuth()
  let polling = 0
  const requests = []
  const fakeFetch = async (url, init) => {
    requests.push({ url, body: init.body })
    if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "1" })
    if (url.endsWith("/deviceauth/token")) {
      polling++
      return polling === 1 ? new Response("", { status: 404 }) : Response.json({ authorization_code: "code", code_verifier: "verifier" })
    }
    return Response.json({ id_token: jwt({ chatgpt_account_id: "identity" }), access_token: "access", refresh_token: "refresh", expires_in: 60 })
  }
  const flow = await authorizeDevice({ fetch: fakeFetch, sleep: async () => {} })
  assert.equal(flow.url, "https://auth.openai.com/codex/device")
  assert.match(flow.instructions, /ABCD/)
  const result = await flow.callback()
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "identity")
  assert.equal(result.refresh, "refresh")
  assert.equal(new URLSearchParams(requests.at(-1).body).get("code_verifier"), "verifier")
})

test("o login usa o sujeito do access token se o id token não o contiver", async () => {
  const { authorizeDevice } = await loadOAuth()
  const fakeFetch = async (url) => {
    if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "1" })
    if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" })
    return Response.json({ id_token: jwt({ chatgpt_account_id: "workspace" }), access_token: jwt({ sub: "person" }), refresh_token: "refresh", expires_in: 60 })
  }
  const result = await (await authorizeDevice({ fetch: fakeFetch })).callback()
  assert.equal(result.userId, "person")
})

test("o login por navegador rejeita state incorreto e aceita o retorno correto", async () => {
  const { authorizeBrowser } = await loadOAuth()
  const fakeFetch = async (_url, init) => {
    const body = new URLSearchParams(init.body)
    assert.equal(body.get("code"), "valid-code")
    assert.ok(body.get("code_verifier"))
    return Response.json({ access_token: jwt({ chatgpt_account_id: "identity" }), refresh_token: "refresh", expires_in: 60 })
  }
  const flow = await authorizeBrowser({ port: 0, fetch: fakeFetch })
  const url = new URL(flow.url)
  const redirect = new URL(url.searchParams.get("redirect_uri"))
  const local = new URL(`http://127.0.0.1:${redirect.port}/auth/callback`)
  const result = flow.callback()
  local.search = new URLSearchParams({ code: "invalid-code", state: "wrong" }).toString()
  assert.equal((await fetch(local)).status, 400)
  local.search = new URLSearchParams({ code: "valid-code", state: url.searchParams.get("state") }).toString()
  assert.equal((await fetch(local)).status, 200)
  assert.equal((await result).accountId, "identity")
})

test("uma autorização por navegador abandonada libera a porta após expirar", async () => {
  const { authorizeBrowser } = await loadOAuth()
  const flow = await authorizeBrowser({ port: 0, timeoutMs: 20, fetch: async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 }) })
  const url = new URL(flow.url)
  const redirect = new URL(url.searchParams.get("redirect_uri"))
  const local = new URL(`http://127.0.0.1:${redirect.port}/auth/callback`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  let stillListening = false
  try { await fetch(local); stillListening = true } catch {}
  if (stillListening) {
    const completion = flow.callback()
    local.search = new URLSearchParams({ code: "cleanup", state: url.searchParams.get("state") }).toString()
    await fetch(local)
    await completion
  }
  assert.equal(stillListening, false)
})
