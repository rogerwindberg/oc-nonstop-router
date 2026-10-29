import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"

const storeModule = new URL("../src/store.js", import.meta.url)

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-store-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function createTestStore(options) {
  assert.ok(existsSync(storeModule), "o armazenamento de contas ainda não foi implementado")
  const { createStore } = await import(storeModule)
  return createStore(options)
}

function oauth(accountId, expires, suffix) {
  return { type: "oauth", accountId, expires, access: `access-${suffix}`, refresh: `refresh-${suffix}` }
}

test("protects account data and its directory", async (t) => {
  const root = await makeFixture(t)
  const directory = path.join(root, "oc-nonstop-router")
  const store = await createTestStore({ directory })
  await store.upsert(oauth("one", 10, "one"))
  assert.equal((await stat(path.join(directory, "accounts.json"))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(directory, ".lock"))).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
})

test("operações concorrentes não perdem atualizações de uma conta", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 100, "one"), "Conta um")

  await Promise.all(Array.from({ length: 12 }, () => store.update("one", async (account) => {
    const before = account.limitedUntil ?? 0
    await new Promise((resolve) => setTimeout(resolve, 2))
    account.limitedUntil = before + 1
  })))

  assert.equal((await store.list())[0].limitedUntil, 12)
})

test("um novo login substitui o token anterior da mesma conta sem criar duplicata", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 300, "old"), "Primeira")
  await store.upsert(oauth("one", 200, "new"), "Renovada")

  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].name, "Renovada")
  assert.equal(accounts[0].auth.refresh, "refresh-new")
})

test("um novo login reabilita uma conta que teve credenciais rejeitadas", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 100, "old"))
  await store.update("one", (account) => { account.invalid = true })
  await store.upsert(oauth("one", 200, "new"))
  assert.notEqual((await store.list())[0].invalid, true)
})

test("identidades diferentes no mesmo workspace não são fundidas", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  const token = (sub) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`
  await store.upsert({ ...oauth("workspace", 100, "first"), access: token("user-one") })
  await store.upsert({ ...oauth("workspace", 100, "second"), access: token("user-two") })
  const accounts = await store.list()
  assert.equal(accounts.length, 2)
  assert.deepEqual(accounts.map((account) => account.auth.refresh).sort(), ["refresh-first", "refresh-second"])
})

test("operações de processos distintos permanecem serializadas após queda do dono do lock", { timeout: 30_000 }, async (t) => {
  const root = await makeFixture(t)
  const directory = path.join(root, "oc-nonstop-router")
  const store = await createTestStore({ directory })
  await store.upsert(oauth("one", 100, "one"))
  await writeFile(path.join(directory, ".lock"), JSON.stringify({ pid: 99999999, token: "dono-morto" }))
  const code = `const {createStore}=await import(process.argv[1]); const s=createStore({directory:process.argv[2]}); await s.update("one", async a=>{const n=a.limitedUntil; await new Promise(r=>setTimeout(r,10)); a.limitedUntil=n+1})`
  const children = Array.from({ length: 16 }, () => spawn(process.execPath, ["--input-type=module", "-e", code, storeModule.href, directory], { stdio: "ignore" }))
  const exits = await Promise.all(children.map(async (child) => (await once(child, "exit"))[0]))
  assert.deepEqual(exits, Array(16).fill(0))
  assert.equal((await store.list())[0].limitedUntil, 16)
})
