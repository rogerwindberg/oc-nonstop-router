import { setTimeout as delay } from "node:timers/promises"
import { refreshIfNeeded } from "./oauth.js"

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const MAX_TIMER = 2_147_000_000

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

    async function invalidateIfUnchanged(id, previous) {
      await store.update(id, (item) => {
        if (item.auth.access === previous.access && item.auth.refresh === previous.refresh) item.invalid = true
      })
    }

    while (true) {
      template.signal.throwIfAborted()
      const accounts = (await store.list()).filter((account) => !account.invalid && !exhausted.has(account.id))
      if (!accounts.length) {
        if (lastQuotaResponse) return lastQuotaResponse
        throw new Error("No valid OAuth accounts available; reconnect an OpenAI account")
      }
      const account = accounts.find((item) => (item.limitedUntil ?? 0) <= now())
      if (!account) {
        const earliest = Math.min(...accounts.map((item) => item.limitedUntil))
        const wait = Math.min(Math.max(earliest - now(), 1), MAX_TIMER)
        await options.onWait?.(wait)
        await sleep(wait, template.signal)
        continue
      }

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
      const next = new Request(new Request(target, template.clone()), { headers, signal })
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
