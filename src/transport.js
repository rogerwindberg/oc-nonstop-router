import { setTimeout as delay } from "node:timers/promises"
import { refreshIfNeeded, refreshNative } from "./oauth.js"
import { sameAccount } from "./store.js"
import { readUsage, releaseIfRecovered } from "./usage.js"

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const USAGE_RECHECK_MS = 300_000
const STATE_RECHECK_MS = 2_000

function residency(access) {
  try {
    const claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString())
    const region = claims["https://api.openai.com/auth"]?.chatgpt_compute_residency ?? claims.chatgpt_compute_residency
    return typeof region === "string" && region && region !== "no_constraint" ? region : undefined
  } catch { return undefined }
}

function retryAfter(value, now, multiplier = 1000) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * multiplier
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

async function rateLimit(response, now, failures) {
  let body
  try { body = await response.clone().json() } catch {}
  const error = body?.error ?? body
  const times = [
    retryAfter(response.headers.get("retry-after"), now),
    retryAfter(response.headers.get("retry-after-ms"), now, 1),
    Number.isFinite(Number(error?.resets_at)) ? Number(error.resets_at) * 1000 : undefined,
    Number.isFinite(Number(error?.resets_in_seconds)) ? now + Number(error.resets_in_seconds) * 1000 : undefined,
  ].filter((value) => Number.isFinite(value) && value > now)
  if (error?.code === "insufficient_quota" && times.length === 0) return undefined
  const fallback = Math.min(60_000 * 2 ** Math.min(failures, 5), 30 * 60_000)
  return times.length ? Math.max(...times) : now + fallback
}

function assertDestination(url) {
  if (url.protocol !== "https:" || !["api.openai.com", "chatgpt.com"].includes(url.hostname) || url.port) {
    throw new Error("Unauthorized domain for OpenAI OAuth credentials")
  }
}

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

export function createNativeFetch(store, options) {
  return async (input, init) => {
    const template = new Request(input, init)
    const source = new URL(template.url)
    assertDestination(source)
    let auth = await options.getAuth()
    if (auth?.type !== "oauth") return (options.fetch ?? fetch)(template)
    const matching = (await store.list()).find((item) => sameAccount(auth, item.auth))
    if (matching) {
      if (auth.expires > matching.auth.expires) {
        await store.update(matching.id, (item) => {
          if (auth.expires > item.auth.expires) { item.auth = { ...auth }; delete item.invalid }
        })
      }
      auth = await abortable(refreshIfNeeded(store, matching.id, { fetch: options.tokenFetch }), template.signal)
    } else if (!auth.access || auth.expires <= Date.now() + 30_000) {
      if (!options.client?.auth?.set) throw new Error("Cannot refresh native OpenCode authentication")
      const previous = auth
      const refreshed = await abortable(refreshNative(auth, { fetch: options.tokenFetch }), template.signal)
      const current = await options.getAuth()
      if (current?.type === "oauth" && current.refresh === previous.refresh) {
        const result = await options.client.auth.set({ path: { id: "openai" }, body: refreshed })
        if (result?.error) throw new Error("Cannot save refreshed OpenCode authentication")
        auth = refreshed
      } else {
        auth = current
      }
    }
    if (auth?.type !== "oauth") return (options.fetch ?? fetch)(template)
    const rewrite = source.hostname === "api.openai.com" &&
      (source.pathname.includes("/v1/responses") || source.pathname.includes("/chat/completions"))
    const headers = new Headers(template.headers)
    headers.set("authorization", `Bearer ${auth.access}`)
    headers.delete("x-opencode-title")
    if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
    else headers.delete("ChatGPT-Account-Id")
    const region = residency(auth.access)
    if (rewrite && region) headers.set("x-openai-internal-codex-residency", region)
    else headers.delete("x-openai-internal-codex-residency")
    return (options.fetch ?? fetch)(new Request(new Request(rewrite ? CODEX_ENDPOINT : source.href, template), { headers, redirect: "error" }))
  }
}

export function createRotatingFetch(store, options = {}) {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))

  return async (input, init) => {
    const template = new Request(input, init)
    const source = new URL(template.url)
    assertDestination(source)
    const rewrite = source.hostname === "api.openai.com" &&
      (source.pathname.includes("/v1/responses") || source.pathname.includes("/chat/completions"))
    const target = rewrite ? CODEX_ENDPOINT : source.href
    const rejected = new Set()
    const exhausted = new Set()
    let lastQuotaResponse
    let nextUsageCheck = now() + USAGE_RECHECK_MS
    let lastWaitReset

    async function invalidateIfUnchanged(id, previous) {
      await store.update(id, (item) => {
        if (item.auth.access === previous.access && item.auth.refresh === previous.refresh) item.invalid = true
      })
    }

    async function checkForRecovery(accounts) {
      const controller = new AbortController()
      const signal = AbortSignal.any([template.signal, controller.signal])
      const checks = accounts.map(async (account) => {
        const claimed = await store.update(account.id, (current) => {
          signal.throwIfAborted()
          if (current.invalid || current.inRotation === false || current.limitedUntil !== account.limitedUntil ||
              (current.failures ?? 0) !== (account.failures ?? 0)) return false
          if (Number.isFinite(current.lastUsageCheckAt) && now() >= current.lastUsageCheckAt &&
              now() - current.lastUsageCheckAt < USAGE_RECHECK_MS) return false
          current.lastUsageCheckAt = now()
          return true
        })
        signal.throwIfAborted()
        if (!claimed) return false
        const usage = await readUsage(store, account.id, { fetch: options.usageFetch, tokenFetch: options.tokenFetch, signal })
        const recovered = await releaseIfRecovered(store, account, usage, signal)
        if (recovered) await options.onRecovery?.(account.name)
        return recovered
      })
      const recovered = Promise.any(checks.map(async (check) => {
        if (await check) return true
        throw new Error("Account remains limited")
      })).catch(() => false)
      try {
        if (!options.disabledFetch) return await abortable(recovered, template.signal)
        while (true) {
          const timer = new AbortController()
          const tick = sleep(STATE_RECHECK_MS, AbortSignal.any([template.signal, timer.signal])).then(() => false)
          const complete = await abortable(Promise.race([recovered.then(() => true), tick]), template.signal)
          timer.abort()
          if (complete || !(await store.isEnabled())) return
        }
      } finally {
        controller.abort()
      }
    }

    while (true) {
      template.signal.throwIfAborted()
      if (options.disabledFetch && !(await store.isEnabled())) return options.disabledFetch(template.clone())
      const accounts = (await store.list()).filter((account) => account.inRotation !== false && !account.invalid && !exhausted.has(account.id))
      if (!accounts.length) {
        if (lastQuotaResponse) return lastQuotaResponse
        throw new Error("No valid OAuth accounts available; reconnect an OpenAI account")
      }
      const account = accounts.find((item) => (item.limitedUntil ?? 0) <= now())
      if (!account) {
        const earliest = Math.min(...accounts.map((item) => item.limitedUntil))
        if (lastWaitReset !== earliest) {
          await options.onWait?.(Math.max(earliest - now(), 1))
          lastWaitReset = earliest
        }
        const wait = Math.min(Math.max(earliest - now(), 1), Math.max(nextUsageCheck - now(), 1),
          options.disabledFetch ? STATE_RECHECK_MS : USAGE_RECHECK_MS)
        await sleep(wait, template.signal)
        template.signal.throwIfAborted()
        if (now() >= nextUsageCheck && now() < earliest && (!options.disabledFetch || await store.isEnabled())) {
          nextUsageCheck = now() + USAGE_RECHECK_MS
          await checkForRecovery(accounts)
        }
        continue
      }
      lastWaitReset = undefined

      let auth
      try {
        auth = await abortable(refreshIfNeeded(store, account.id, { fetch: options.tokenFetch }), template.signal)
      } catch (error) {
        if (error.status !== 400 && error.status !== 401) throw error
        await invalidateIfUnchanged(account.id, account.auth)
        continue
      }
      const headers = new Headers(template.headers)
      headers.set("authorization", `Bearer ${auth.access}`)
      headers.delete("x-opencode-title")
      if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
      else headers.delete("ChatGPT-Account-Id")
      const region = residency(auth.access)
      if (rewrite && region) headers.set("x-openai-internal-codex-residency", region)
      else headers.delete("x-openai-internal-codex-residency")

      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(new Error("Timed out connecting to OpenAI")), 300_000)
      timer.unref?.()
      const signal = AbortSignal.any([template.signal, timeout.signal])
      const next = new Request(new Request(target, template.clone()), { headers, signal, redirect: "error" })
      let response
      try { response = await fetcher(next) } finally { clearTimeout(timer) }

      if (response.status === 401) {
        if (!rejected.has(account.id)) {
          rejected.add(account.id)
          try {
            await abortable(refreshIfNeeded(store, account.id, { fetch: options.tokenFetch, rejectedAccess: auth.access }), template.signal)
          } catch (error) {
            if (error.status !== 400 && error.status !== 401) throw error
            await invalidateIfUnchanged(account.id, auth)
          }
        } else {
          await invalidateIfUnchanged(account.id, auth)
        }
        response.body?.cancel().catch(() => {})
        continue
      }
      if (response.status !== 429) return response

      const reset = await rateLimit(response, now(), account.failures ?? 0)
      if (reset === undefined) {
        exhausted.add(account.id)
        lastQuotaResponse = response
        continue
      }
      await store.update(account.id, (item) => {
        item.limitedUntil = Math.max(item.limitedUntil ?? 0, reset)
        item.failures = (item.failures ?? 0) + 1
      })
      response.body?.cancel().catch(() => {})
      await options.onLimit?.(account.name, reset)
    }
  }
}
