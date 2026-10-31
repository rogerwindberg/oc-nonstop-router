import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"
import { readUsage, releaseIfRecovered } from "../src/usage.js"

test("retrieves usage windows for the selected account without exposing credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-usage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "workspace", access: "private-access", refresh: "private-refresh", expires: Date.now() + 60_000 }, "Personal")
  const usage = await readUsage(store, "workspace", { fetch: async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage")
    assert.equal(init.headers.authorization, "Bearer private-access")
    assert.equal(init.headers["ChatGPT-Account-Id"], "workspace")
    assert.equal(init.redirect, "error")
    return Response.json({ plan_type: "plus", rate_limit_reset_credits: { available_count: 2 }, rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 22, limit_window_seconds: 86400, reset_at: 2_000_000_000 },
      secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 2_000_500_000 },
    } })
  } })
  assert.deepEqual(usage.windows.map(({ used, duration, resetAt }) => [used, duration, resetAt]), [[22, 86400, 2_000_000_000_000], [55, 604800, 2_000_500_000_000]])
  assert.equal(usage.plan, "plus")
  assert.equal(usage.resetCredits, 2)
  assert.equal(usage.allowed, true)
  assert.equal(usage.limitReached, false)
  assert.doesNotMatch(JSON.stringify(usage), /private-access|private-refresh/)
})

test("does not clear a newer rate limit when an older usage check reports recovery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-usage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "workspace", access: "access", refresh: "refresh", expires: Date.now() + 60_000 })
  await store.update("workspace", (account) => { account.limitedUntil = 2_000_000_000_000; account.failures = 1 })
  const [snapshot] = await store.list()
  await store.update("workspace", (account) => { account.limitedUntil = 2_000_000_100_000; account.failures = 2 })
  assert.equal(await releaseIfRecovered(store, snapshot, { allowed: true, limitReached: false }), false)
  const [current] = await store.list()
  assert.equal(current.limitedUntil, 2_000_000_100_000)
  assert.equal(current.failures, 2)
})

test("only explicit confirmation clears an unchanged rate limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-usage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "workspace", access: "access", refresh: "refresh", expires: Date.now() + 60_000 })
  await store.update("workspace", (account) => { account.limitedUntil = 2_000_000_000_000; account.failures = 1 })
  const [snapshot] = await store.list()
  assert.equal(await releaseIfRecovered(store, snapshot, { allowed: true }), false)
  assert.equal(await releaseIfRecovered(store, snapshot, { allowed: false, limitReached: false }), false)
  assert.equal((await store.list())[0].limitedUntil, 2_000_000_000_000)
  assert.equal(await releaseIfRecovered(store, snapshot, { allowed: true, limitReached: false }), true)
  assert.equal((await store.list())[0].limitedUntil, 0)
})

test("uses relative reset times and preserves separate model-specific usage windows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-usage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "workspace", access: "access", refresh: "refresh", expires: Date.now() + 60_000 })
  const result = await readUsage(store, "workspace", { fetch: async () => Response.json({
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 120 } },
    additional_rate_limits: [{ limit_name: "special-model", rate_limit: { secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: 2_000_500_000 } } }],
  }) })
  assert.equal(result.windows[0].resetAt, result.checkedAt + 120_000)
  assert.equal(result.windows[1].name, "special-model")
  assert.equal(result.windows[1].used, 90)
})

test("reports unavailable usage instead of inventing limits or returning response details", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-usage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore({ directory: root })
  await store.upsert({ type: "oauth", accountId: "workspace", access: "access", refresh: "refresh", expires: Date.now() + 60_000 })
  const usage = await readUsage(store, "workspace", { fetch: async () => new Response("private response", { status: 403 }) })
  assert.equal(usage.available, false)
  assert.deepEqual(usage.windows, [])
  assert.doesNotMatch(JSON.stringify(usage), /private response|access|refresh/)
})
