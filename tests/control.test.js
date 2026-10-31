import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"
import { createController, formatError, formatUsage, formatDateTime, formatTime, getFooterSummaryData, formatFooterSummary, parseCommand } from "../src/control.js"

test("recognizes only complete nonstop commands", () => {
  assert.equal(parseCommand("/nonstop enable"), "enable")
  assert.equal(parseCommand("/nonstop disable"), "disable")
  assert.equal(parseCommand("/nonstop config"), "config")
  assert.equal(parseCommand("/nonstop status"), "status")
  assert.equal(parseCommand("/nonstop enable extra"), undefined)
  assert.equal(parseCommand("normal message"), undefined)
})

test("shows actionable English errors without exposing unknown provider details", () => {
  assert.equal(formatError(new Error("Invalid account name")), "Invalid account name")
  assert.equal(formatError(new Error("provider failure: private-credential")), "Operation failed. Please try again.")
  assert.equal(formatError({ code: "EADDRINUSE" }), "The local authorization port is already in use.")
})

test("status shows ordered accounts and reported limits without credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-control-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "one", access: "secret-access", refresh: "secret-refresh", expires: Date.now() + 60_000 }, "Work")
  const controller = createController(store, { usage: async () => ({ available: true, checkedAt: 2_000_000_000_000, windows: [
    { used: 20, duration: 86400, resetAt: 2_000_000_000_000 },
    { used: 75, duration: 604800, resetAt: 2_000_500_000_000 },
  ] }) })
  const status = await controller.status()
  assert.match(status, /Nonstop Router: ON/)
  assert.match(status, /Work/)
  assert.match(status, /Daily: 20% used/)
  assert.match(status, /Weekly: 75% used/)
  assert.doesNotMatch(status, /secret-access|secret-refresh/)
  await controller.setEnabled(false)
  assert.match(await controller.status(), /Nonstop Router: OFF/)
})

test("usage does not mislabel a five-hour window as a daily limit", () => {
  const result = formatUsage({ available: true, windows: [{ used: 40, duration: 18000, resetAt: null }] })
  assert.match(result, /5-hour: 40% used/)
  assert.match(result, /Daily: unavailable/)
  assert.match(result, /Weekly: unavailable/)
})

test("status notices a manually restored quota and releases the account", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-control-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "one", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }, "Work")
  await store.update("one", (account) => { account.limitedUntil = Date.now() + 3_600_000; account.failures = 1 })
  const controller = createController(store, { usage: async () => ({ allowed: true, limitReached: false, windows: [] }) })
  assert.match(await controller.status(), /Work — available/)
  assert.equal((await store.list())[0].limitedUntil, 0)
})

test("adding an already signed-in account is explicit and does not replace newer stored credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-control-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert({ type: "oauth", accountId: "one", access: "fresh", refresh: "fresh-refresh", expires: 200 }, "Work")
  await store.setInRotation("one", false)
  const data = path.join(root, "opencode")
  await mkdir(data)
  await writeFile(path.join(data, "auth.json"), JSON.stringify({ openai: { type: "oauth", accountId: "one", access: "old", refresh: "old-refresh", expires: 100 } }))
  const controller = createController(store, { dataRoot: root })
  await controller.addNative()
  const [account] = await store.list()
  assert.equal(account.inRotation, true)
  assert.equal(account.auth.refresh, "fresh-refresh")
  assert.equal(account.name, "Work")
})

test("adding a newer native login reactivates the existing account", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-control-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: path.join(root, "oc-nonstop-router") })
  await store.upsert({ type: "oauth", accountId: "one", access: "old", refresh: "old-refresh", expires: 100 }, "Work")
  await store.update("one", (account) => { account.invalid = true })
  const data = path.join(root, "opencode")
  await mkdir(data)
  await writeFile(path.join(data, "auth.json"), JSON.stringify({ openai: { type: "oauth", accountId: "one", access: "new", refresh: "new-refresh", expires: 200 } }))
  await createController(store, { dataRoot: root }).addNative()
  const [account] = await store.list()
  assert.equal(account.auth.refresh, "new-refresh")
  assert.notEqual(account.invalid, true)
})

test("formats dates and times in MM/DD HH:MM and HH:MM format using local timezone", () => {
  const d = new Date(2026, 9, 30, 15, 32, 10)
  assert.equal(formatDateTime(d.getTime()), "10/30 15:32")
  assert.equal(formatTime(d.getTime()), "15:32")
  assert.equal(formatDateTime(null), "unknown")
  assert.equal(formatTime(null), "unknown")
})

test("formats footer summary with only 5-hour and weekly windows, no plan, and summarized dates", () => {
  const account = { name: "Account 1" }
  const reset5h = new Date(2026, 9, 30, 15, 32, 10).getTime()
  const resetWeekly = new Date(2026, 10, 6, 1, 56, 54).getTime()
  const checkTime = new Date(2026, 9, 30, 12, 19, 3).getTime()
  const usage = {
    windows: [
      { used: 92, duration: 18000, resetAt: reset5h },
      { used: 45, duration: 604800, resetAt: resetWeekly },
      { used: 10, duration: 86400, resetAt: reset5h + 86400000 },
    ],
    plan: "plus",
    resetCredits: 0,
    checkedAt: checkTime,
  }
  const summary = formatFooterSummary(account, usage)
  assert.equal(
    summary,
    "Usage for Account 1: 5-hour: 92% used (resets 10/30 15:32) · Weekly: 45% used (resets 11/06 01:56) · Available resets: 0 · Last check: 12:19"
  )
  const data = getFooterSummaryData(account, usage)
  assert.equal(data.items.length, 2)
  assert.equal(data.items[0].used, 92)
  assert.ok(data.items[0].used > 80)
  assert.equal(data.items[1].used, 45)
  assert.ok(data.items[1].used <= 80)
})

test("status command formats limitedUntil with summarized date and time", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-control-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "one", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }, "Account 1")
  const limitedTime = new Date(2026, 9, 30, 15, 32, 0).getTime()
  await store.update("one", (account) => { account.limitedUntil = limitedTime; account.failures = 1 })
  const controller = createController(store, { usage: async () => ({ available: false, windows: [] }) })
  const status = await controller.status()
  assert.match(status, /Account 1 — limited until 10\/30 15:32/)
})
