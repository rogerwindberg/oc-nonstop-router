import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createStore } from "../src/store.js"

const transportModule = new URL("../src/transport.js", import.meta.url)

async function loadTransport() {
  assert.ok(existsSync(transportModule), "rotating transport is not implemented")
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

test("switches accounts on HTTP 429 and repeats the request body", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const attempts = []
  const fetcher = async (req) => {
    attempts.push({ url: req.url, account: req.headers.get("ChatGPT-Account-Id"), auth: req.headers.get("authorization"), body: await req.text() })
    assert.equal(req.redirect, "error")
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

test("does not route to accounts removed from the sequence", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.setInRotation("one", false)
  const used = []
  const send = createRotatingFetch(store, { fetch: async (req) => { used.push(req.headers.get("ChatGPT-Account-Id")); return new Response("ok") } })
  assert.equal(await (await send(input, request())).text(), "ok")
  assert.deepEqual(used, ["two"])
})

test("when disabled, sends through the native account once and does not rotate or wait", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.setEnabled(false)
  let bypasses = 0
  const send = createRotatingFetch(store, {
    disabledFetch: async (_input, _init) => { bypasses++; return new Response("native limit", { status: 429 }) },
    fetch: async () => { throw new Error("router should not send") },
  })
  assert.equal((await send(input, request())).status, 429)
  assert.equal(bypasses, 1)
  assert.deepEqual((await store.list()).map((account) => account.limitedUntil), [0, 0])
})

test("switching off while waiting stops retries and uses native authentication", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let now = Date.now()
  const attempts = []
  const send = createRotatingFetch(store, {
    now: () => now,
    fetch: async (req) => { attempts.push(req.headers.get("ChatGPT-Account-Id")); return new Response("limited", { status: 429, headers: { "Retry-After": "60" } }) },
    sleep: async (ms) => { now += ms; await store.setEnabled(false) },
    disabledFetch: async () => new Response("native"),
  })
  assert.equal(await (await send(input, request())).text(), "native")
  assert.deepEqual(attempts, ["one", "two"])
})

test("native bypass uses the OpenCode account rather than the first router account", async (t) => {
  const { createNativeFetch } = await loadTransport()
  const store = await makeStore(t)
  const native = { type: "oauth", accountId: "two", access: "access-two", refresh: "refresh-two", expires: Date.now() + 3_600_000 }
  const seen = []
  const send = createNativeFetch(store, { getAuth: async () => native, fetch: async (req) => {
    assert.equal(req.redirect, "error")
    seen.push([req.url, req.headers.get("authorization"), req.headers.get("ChatGPT-Account-Id")])
    return new Response("limited", { status: 429 })
  } })
  assert.equal((await send(input, request())).status, 429)
  assert.deepEqual(seen, [["https://chatgpt.com/backend-api/codex/responses", "Bearer access-two", "two"]])
})

test("native bypass reuses a newer token already refreshed for the native account", async (t) => {
  const { createNativeFetch } = await loadTransport()
  const store = await makeStore(t)
  const native = { type: "oauth", accountId: "two", access: "old", refresh: "old-refresh", expires: 1 }
  let auth
  const send = createNativeFetch(store, { getAuth: async () => native, fetch: async (req) => { auth = req.headers.get("authorization"); return new Response("ok") } })
  assert.equal((await send(input, request())).status, 200)
  assert.equal(auth, "Bearer access-two")
})

test("native bypass honors a more recent OpenCode login for the same account", async (t) => {
  const { createNativeFetch } = await loadTransport()
  const store = await makeStore(t)
  const native = { type: "oauth", accountId: "two", access: "fresh-native", refresh: "fresh-native-refresh", expires: Date.now() + 7_200_000 }
  let auth
  const send = createNativeFetch(store, { getAuth: async () => native, fetch: async (req) => { auth = req.headers.get("authorization"); return new Response("ok") } })
  await send(input, request())
  assert.equal(auth, "Bearer fresh-native")
})

test("native bypass refreshes an expired native account without adding it to the router", async (t) => {
  const { createNativeFetch } = await loadTransport()
  const store = await makeStore(t)
  const native = { type: "oauth", accountId: "native", access: "old-native", refresh: "native-refresh", expires: 1 }
  let saved
  let authorization
  const send = createNativeFetch(store, {
    getAuth: async () => native,
    client: { auth: { set: async ({ body }) => { saved = body } } },
    tokenFetch: async () => Response.json({ access_token: "renewed-native", refresh_token: "renewed-refresh", expires_in: 3600 }),
    fetch: async (req) => { authorization = req.headers.get("authorization"); return new Response("ok") },
  })
  assert.equal((await send(input, request())).status, 200)
  assert.equal(authorization, "Bearer renewed-native")
  assert.equal(saved.refresh, "renewed-refresh")
  assert.deepEqual((await store.list()).map((account) => account.id), ["one", "two"])
})

test("native bypass does not replace an OpenCode login changed during refresh", async (t) => {
  const { createNativeFetch } = await loadTransport()
  const store = await makeStore(t)
  const old = { type: "oauth", accountId: "old", access: "old", refresh: "old-refresh", expires: 1 }
  const fresh = { type: "oauth", accountId: "new", access: "new-login", refresh: "new-refresh", expires: Date.now() + 60_000 }
  let calls = 0
  let authorization
  const send = createNativeFetch(store, {
    getAuth: async () => ++calls === 1 ? old : fresh,
    client: { auth: { set: async () => { throw new Error("must not overwrite") } } },
    tokenFetch: async () => Response.json({ access_token: "old-renewed", refresh_token: "rotated", expires_in: 3600 }),
    fetch: async (req) => { authorization = req.headers.get("authorization"); return new Response("ok") },
  })
  assert.equal((await send(input, request())).status, 200)
  assert.equal(authorization, "Bearer new-login")
})

test("waits for the first reset when all accounts reach their limits", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let now = Date.now()
  const waited = []
  const accounts = []
  const fetcher = async (req) => {
    const id = req.headers.get("ChatGPT-Account-Id")
    accounts.push(id)
    if (accounts.length <= 2) return new Response("{}", { status: 429, headers: { "Retry-After": id === "one" ? "2" : "5" } })
    return new Response("resumed")
  }
  const send = createRotatingFetch(store, {
    fetch: fetcher, now: () => now,
    sleep: async (ms) => { waited.push(ms); now += ms },
  })
  assert.equal(await (await send(input, request())).text(), "resumed")
  assert.deepEqual(accounts, ["one", "two", "one"])
  assert.deepEqual(waited, [2000])
})

test("resumes the pending request after a manual quota reset, before the original deadline", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const started = Date.now()
  let now = started
  const attempts = []
  const checks = []
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => { now += ms },
    fetch: async (req) => {
      attempts.push(req.headers.get("ChatGPT-Account-Id"))
      return attempts.length <= 2 ? new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }) : new Response("resumed")
    },
    usageFetch: async (_url, init) => {
      const account = init.headers["ChatGPT-Account-Id"]
      checks.push(account)
      return Response.json({ rate_limit: { allowed: account === "two", limit_reached: account !== "two" } })
    },
  })
  assert.equal(await (await send(input, request())).text(), "resumed")
  assert.deepEqual(attempts, ["one", "two", "two"])
  assert.deepEqual(checks.sort(), ["one", "two"])
  assert.ok(now - started >= 300_000 && now - started < 3_600_000)
})

test("validates all configured accounts when all are limited and switches to any account that recovered", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.upsert({ type: "oauth", accountId: "three", access: "access-three", refresh: "refresh-three", expires: Date.now() + 3_600_000 }, "three")
  const started = Date.now()
  let now = started
  const attempts = []
  const checks = []
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => { now += ms },
    fetch: async (req) => {
      attempts.push(req.headers.get("ChatGPT-Account-Id"))
      return attempts.length <= 3 ? new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }) : new Response("resumed")
    },
    usageFetch: async (_url, init) => {
      const account = init.headers["ChatGPT-Account-Id"]
      checks.push(account)
      return Response.json({ rate_limit: { allowed: account === "two", limit_reached: account !== "two" } })
    },
  })
  assert.equal(await (await send(input, request())).text(), "resumed")
  assert.deepEqual(attempts, ["one", "two", "three", "two"])
  assert.deepEqual(checks.sort(), ["one", "three", "two"])
  assert.ok(now - started >= 300_000 && now - started < 3_600_000)
})

test("continues checking a limited account until a later manual reset is confirmed", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.setInRotation("two", false)
  const started = Date.now()
  let now = started
  let checks = 0
  const attempts = []
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => { now += ms },
    fetch: async (req) => {
      attempts.push(req.headers.get("ChatGPT-Account-Id"))
      return attempts.length === 1 ? new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }) : new Response("resumed")
    },
    usageFetch: async () => {
      checks++
      return Response.json({ rate_limit: { allowed: checks > 1, limit_reached: checks === 1 } })
    },
  })
  assert.equal(await (await send(input, request())).text(), "resumed")
  assert.deepEqual(attempts, ["one", "one"])
  assert.equal(checks, 2)
  assert.equal(now - started, 600_000)
})

test("concurrent requests share the quota recheck interval", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.setInRotation("two", false)
  let now = Date.now()
  await store.update("one", (account) => { account.limitedUntil = now + 3_600_000; account.failures = 1 })
  const waiters = []
  let checks = 0
  let started
  const checking = new Promise((resolve) => { started = resolve })
  const sleep = (_ms, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    waiters.push(resolve)
  })
  const usageFetch = async (_url, init) => {
    checks++
    started()
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
  }
  const send = createRotatingFetch(store, { now: () => now, sleep, usageFetch })
  const first = new AbortController()
  const second = new AbortController()
  const outcomes = [first, second].map((controller) => send(input, { ...request(), signal: controller.signal }).catch((error) => error.name))
  while (waiters.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
  now += 300_000
  for (const release of waiters.splice(0)) release()
  await checking
  while (waiters.length < 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(checks, 1)
  first.abort()
  second.abort()
  assert.deepEqual(await Promise.all(outcomes), ["AbortError", "AbortError"])
})

test("a quota restored by another status check wakes the pending request", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const { releaseIfRecovered } = await import("../src/usage.js")
  const store = await makeStore(t)
  await store.setInRotation("two", false)
  const started = Date.now()
  let now = started
  await store.update("one", (account) => { account.limitedUntil = now + 3_600_000; account.failures = 1 })
  const [snapshot] = await store.list()
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => {
      now += ms
      await releaseIfRecovered(store, snapshot, { allowed: true, limitReached: false })
    },
    disabledFetch: async () => { throw new Error("native bypass should not be used") },
    fetch: async () => new Response("resumed"),
  })
  assert.equal(await (await send(input, request())).text(), "resumed")
  assert.equal(now - started, 2000)
})

test("keeps waiting when a usage check fails or does not confirm the reset", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const abort = new AbortController()
  let now = Date.now()
  let checks = 0
  const attempts = []
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => { now += ms; if (checks >= 2) abort.abort() },
    fetch: async (req) => { attempts.push(req.headers.get("ChatGPT-Account-Id")); return new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }) },
    usageFetch: async () => { checks++; return checks === 1 ? new Response("failure", { status: 503 }) : Response.json({ rate_limit: { allowed: true } }) },
  })
  await assert.rejects(send(input, { ...request(), signal: abort.signal }), { name: "AbortError" })
  assert.deepEqual(attempts, ["one", "two"])
  assert.ok((await store.list()).every((account) => account.limitedUntil > now))
})

test("uses the original reset deadline when quota checks are unavailable", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  await store.setInRotation("two", false)
  const started = Date.now()
  let now = started
  let checks = 0
  let attempts = 0
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => { now += ms },
    fetch: async () => ++attempts === 1
      ? new Response("{}", { status: 429, headers: { "Retry-After": "605" } }) : new Response("resumed"),
    usageFetch: async () => { checks++; return new Response("unavailable", { status: 503 }) },
  })
  assert.equal(await (await send(input, request())).text(), "resumed")
  assert.equal(now - started, 605_000)
  assert.equal(checks, 2)
  assert.equal(attempts, 2)
})

test("cancellation interrupts a pending quota recheck", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const abort = new AbortController()
  let now = Date.now()
  let started
  const checking = new Promise((resolve) => { started = resolve })
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms) => { now += ms },
    fetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
    usageFetch: async (_url, init) => {
      started()
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
    },
  })
  const result = send(input, { ...request(), signal: abort.signal }).then(() => "completed", (error) => error.name)
  await checking
  abort.abort()
  assert.equal(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve("pending"), 200))]), "AbortError")
  assert.ok((await store.list()).every((account) => account.limitedUntil > now))
})

test("turning the router off interrupts a pending quota recheck", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let now = Date.now()
  let started
  const checking = new Promise((resolve) => { started = resolve })
  const send = createRotatingFetch(store, {
    now: () => now,
    sleep: async (ms, signal) => {
      now += ms
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5)
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
    },
    fetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
    disabledFetch: async () => new Response("native"),
    usageFetch: async (_url, init) => {
      started()
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
    },
  })
  const result = send(input, request()).then((response) => response.text())
  await checking
  await store.setEnabled(false)
  assert.equal(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve("pending"), 500))]), "native")
  assert.ok((await store.list()).every((account) => account.limitedUntil > now))
})

test("cancelling the session interrupts the quota wait", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const abort = new AbortController()
  const send = createRotatingFetch(store, { fetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }) })
  const promise = send(input, { ...request(), signal: abort.signal })
  setTimeout(() => abort.abort(), 20)
  await assert.rejects(promise, { name: "AbortError" })
})

test("HTTP 403 is not treated as an account limit", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let attempts = 0
  const send = createRotatingFetch(store, { fetch: async () => { attempts++; return new Response("forbidden", { status: 403 }) } })
  assert.equal((await send(input, request())).status, 403)
  assert.equal(attempts, 1)
  assert.equal((await store.list())[0].limitedUntil, 0)
})

test("refreshes the token once after HTTP 401 before retrying", async (t) => {
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

test("does not send an OAuth token to a non-OpenAI domain", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  const send = createRotatingFetch(store, { fetch: async () => { throw new Error("should not send") } })
  await assert.rejects(send("https://example.com/v1/responses", request()), /domain/i)
})

test("does not retry a streaming response that has already started", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let attempts = 0
  const stream = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"error","error":{"code":"usage_limit_reached"}}\n\n'
  const send = createRotatingFetch(store, { fetch: async () => { attempts++; return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }) } })
  assert.equal(await (await send(input, request())).text(), stream)
  assert.equal(attempts, 1)
})

test("quota without a reset on one account still allows another account", async (t) => {
  const { createRotatingFetch } = await loadTransport()
  const store = await makeStore(t)
  let calls = 0
  const send = createRotatingFetch(store, { fetch: async () => ++calls === 1
    ? Response.json({ error: { code: "insufficient_quota" } }, { status: 429 })
    : new Response("ok") })
  assert.equal(await (await send(input, request())).text(), "ok")
  assert.equal(calls, 2)
})

test("rejection of an old refresh token does not invalidate a newer login", async (t) => {
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

test("cancellation returns immediately during an ongoing refresh", async (t) => {
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
  const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("pending"), 100))])
  unblock(Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 }))
  await outcome
  assert.equal(result, "AbortError")
})
