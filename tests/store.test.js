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
  assert.ok(existsSync(storeModule), "account storage is not implemented")
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

test("concurrent operations do not lose account updates", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 100, "one"), "Account one")

  await Promise.all(Array.from({ length: 12 }, () => store.update("one", async (account) => {
    const before = account.limitedUntil ?? 0
    await new Promise((resolve) => setTimeout(resolve, 2))
    account.limitedUntil = before + 1
  })))

  assert.equal((await store.list())[0].limitedUntil, 12)
})

test("router state and account order persist while removed accounts can be added back", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 100, "one"), "One")
  await store.upsert(oauth("two", 100, "two"), "Two")
  assert.equal(await store.isEnabled(), true)
  await store.setEnabled(false)
  await store.move("two", -1)
  await store.rename("one", "Personal")
  await store.setInRotation("two", false)
  assert.equal(await store.isEnabled(), false)
  assert.deepEqual((await store.list()).map(({ name, inRotation }) => [name, inRotation !== false]), [["Two", false], ["Personal", true]])
  await store.setInRotation("two", true)
  assert.deepEqual((await store.list()).map(({ name }) => name), ["Personal", "Two"])
  await store.setInRotation("one", true)
  assert.deepEqual((await store.list()).map(({ name }) => name), ["Personal", "Two"])
  await assert.rejects(store.rename("one", "  "), /name/i)
})

test("moving an account changes its position among the accounts in rotation", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  for (const id of ["one", "two", "three"]) await store.upsert(oauth(id, 100, id), id)
  await store.setInRotation("two", false)
  await store.move("three", -1)
  assert.deepEqual((await store.list()).filter((account) => account.inRotation !== false).map((account) => account.name), ["three", "one"])
})

test("a new login replaces the previous account token without creating a duplicate", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 300, "old"), "First")
  await store.upsert(oauth("one", 200, "new"), "Renewed")

  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].name, "Renewed")
  assert.equal(accounts[0].auth.refresh, "refresh-new")
})

test("a new login re-enables an account whose credentials were rejected", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert(oauth("one", 100, "old"))
  await store.update("one", (account) => { account.invalid = true })
  await store.upsert(oauth("one", 200, "new"))
  assert.notEqual((await store.list())[0].invalid, true)
})

test("different identities in the same workspace are not merged", async (t) => {
  const root = await makeFixture(t)
  const store = await createTestStore({ directory: path.join(root, "oc-nonstop-router") })
  const token = (sub) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`
  await store.upsert({ ...oauth("workspace", 100, "first"), access: token("user-one") })
  await store.upsert({ ...oauth("workspace", 100, "second"), access: token("user-two") })
  const accounts = await store.list()
  assert.equal(accounts.length, 2)
  assert.deepEqual(accounts.map((account) => account.auth.refresh).sort(), ["refresh-first", "refresh-second"])
})

test("operations across processes remain serialized after a lock owner exits", { timeout: 30_000 }, async (t) => {
  const root = await makeFixture(t)
  const directory = path.join(root, "oc-nonstop-router")
  const store = await createTestStore({ directory })
  await store.upsert(oauth("one", 100, "one"))
  await writeFile(path.join(directory, ".lock"), JSON.stringify({ pid: 99999999, token: "dead-owner" }))
  const code = `const {createStore}=await import(process.argv[1]); const s=createStore({directory:process.argv[2]}); await s.update("one", async a=>{const n=a.limitedUntil; await new Promise(r=>setTimeout(r,10)); a.limitedUntil=n+1})`
  const children = Array.from({ length: 16 }, () => spawn(process.execPath, ["--input-type=module", "-e", code, storeModule.href, directory], { stdio: "ignore" }))
  const exits = await Promise.all(children.map(async (child) => (await once(child, "exit"))[0]))
  assert.deepEqual(exits, Array(16).fill(0))
  assert.equal((await store.list())[0].limitedUntil, 16)
})
