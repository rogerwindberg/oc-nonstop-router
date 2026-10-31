import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"

const hooksModule = new URL("../src/hooks.js", import.meta.url)

async function setup(t) {
  assert.ok(existsSync(hooksModule), "OpenCode hooks are not implemented")
  const { buildHooks } = await import(hooksModule)
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-hooks-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: path.join(root, "oc-nonstop-router") })
  return { store, buildHooks }
}

test("OAuth login adds the authenticated account to storage", async (t) => {
  const { store, buildHooks } = await setup(t)
  const hooks = buildHooks({ store, browser: async () => ({
    url: "https://auth.openai.com/authorize", instructions: "login", method: "auto",
    callback: async () => ({ type: "success", accountId: "one", access: "secret-access", refresh: "secret-refresh", expires: Date.now() + 60_000 }),
  }) })
  const flow = await hooks.auth.methods[0].authorize({ name: "Work account" })
  assert.equal((await flow.callback()).type, "success")
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].name, "Work account")
  assert.equal(accounts[0].id, "one")
  const status = await hooks.tool.nonstop_router_status.execute()
  assert.match(status, /Work account/)
  assert.doesNotMatch(status, /secret-access|secret-refresh/)
})

test("loader only replaces the transport for OpenAI OAuth authentication", async (t) => {
  const { store, buildHooks } = await setup(t)
  const hooks = buildHooks({ store })
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "api", key: "api-key" })), {})
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth", accountId: "one", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }))
  assert.equal(typeof loaded.fetch, "function")
  assert.equal((await store.list()).length, 1)
})

test("loading while disabled does not add the native account to the sequence", async (t) => {
  const { store, buildHooks } = await setup(t)
  await store.setEnabled(false)
  const hooks = buildHooks({ store })
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth", accountId: "one", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }))
  assert.equal(typeof loaded.fetch, "function")
  assert.equal((await store.list()).length, 0)
})

test("loader adopts a newer native login for an existing router account", async (t) => {
  const { store, buildHooks } = await setup(t)
  const now = Date.now()
  await store.upsert({ type: "oauth", accountId: "one", access: "old", refresh: "old-refresh", expires: now + 60_000 }, "Personal")
  const hooks = buildHooks({ store })
  await hooks.auth.loader(async () => ({ type: "oauth", accountId: "one", access: "new", refresh: "new-refresh", expires: now + 120_000 }))
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].name, "Personal")
  assert.equal(accounts[0].auth.refresh, "new-refresh")
})

test("loader does not replace fresher router credentials with an older native login", async (t) => {
  const { store, buildHooks } = await setup(t)
  const now = Date.now()
  await store.upsert({ type: "oauth", accountId: "one", access: "new", refresh: "new-refresh", expires: now + 120_000 })
  const hooks = buildHooks({ store })
  await hooks.auth.loader(async () => ({ type: "oauth", accountId: "one", access: "old", refresh: "old-refresh", expires: now + 60_000 }))
  assert.equal((await store.list())[0].auth.refresh, "new-refresh")
})

test("failed login does not add an account", async (t) => {
  const { store, buildHooks } = await setup(t)
  const hooks = buildHooks({ store, device: async () => ({
    url: "https://auth.openai.com/device", instructions: "login", method: "auto",
    callback: async () => ({ type: "failed" }),
  }) })
  const flow = await hooks.auth.methods[1].authorize({ name: "Failure" })
  assert.deepEqual(await flow.callback(), { type: "failed" })
  assert.equal((await store.list()).length, 0)
})
