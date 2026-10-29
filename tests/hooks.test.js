import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"

const hooksModule = new URL("../src/hooks.js", import.meta.url)

async function setup(t) {
  assert.ok(existsSync(hooksModule), "os hooks do OpenCode ainda não foram implementados")
  const { buildHooks } = await import(hooksModule)
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-hooks-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: path.join(root, "oc-nonstop-router") })
  return { store, buildHooks }
}

test("cadastro OAuth adiciona a conta autenticada ao armazenamento", async (t) => {
  const { store, buildHooks } = await setup(t)
  const hooks = buildHooks({ store, browser: async () => ({
    url: "https://auth.openai.com/authorize", instructions: "login", method: "auto",
    callback: async () => ({ type: "success", accountId: "one", access: "secret-access", refresh: "secret-refresh", expires: Date.now() + 60_000 }),
  }) })
  const flow = await hooks.auth.methods[0].authorize({ name: "Conta trabalho" })
  assert.equal((await flow.callback()).type, "success")
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].name, "Conta trabalho")
  assert.equal(accounts[0].id, "one")
  const status = await hooks.tool.nonstop_router_status.execute()
  assert.match(status, /Conta trabalho/)
  assert.doesNotMatch(status, /secret-access|secret-refresh/)
})

test("loader só substitui o transporte quando a autenticação OpenAI é OAuth", async (t) => {
  const { store, buildHooks } = await setup(t)
  const hooks = buildHooks({ store })
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "api", key: "api-key" })), {})
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth", accountId: "one", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }))
  assert.equal(typeof loaded.fetch, "function")
  assert.equal((await store.list()).length, 1)
})

test("uma falha no login não cadastra uma conta", async (t) => {
  const { store, buildHooks } = await setup(t)
  const hooks = buildHooks({ store, device: async () => ({
    url: "https://auth.openai.com/device", instructions: "login", method: "auto",
    callback: async () => ({ type: "failed" }),
  }) })
  const flow = await hooks.auth.methods[1].authorize({ name: "Falha" })
  assert.deepEqual(await flow.callback(), { type: "failed" })
  assert.equal((await store.list()).length, 0)
})
