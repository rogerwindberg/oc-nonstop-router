import { refreshIfNeeded } from "./oauth.js"

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

export async function readUsage(store, id, options = {}) {
  const checkedAt = Date.now()
  try {
    options.signal?.throwIfAborted()
    const auth = await refreshIfNeeded(store, id, { fetch: options.tokenFetch })
    options.signal?.throwIfAborted()
    const headers = { authorization: `Bearer ${auth.access}` }
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      headers, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error("Usage unavailable")
    const body = await response.json()
    const groups = [{ name: null, rate: body?.rate_limit }, ...(Array.isArray(body?.additional_rate_limits)
      ? body.additional_rate_limits.map((item) => ({ name: item?.limit_name, rate: item?.rate_limit })) : [])]
    const windows = groups.flatMap(({ name, rate }) => [rate?.primary_window, rate?.secondary_window]
      .filter((window) => window && Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100)
      .map((window) => {
        const absolute = Number.isFinite(window.reset_at) && window.reset_at > 0 ? window.reset_at * 1000 : null
        const relative = Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds > 0
          ? checkedAt + window.reset_after_seconds * 1000 : null
        const resetAt = absolute ?? relative
        return {
          ...(typeof name === "string" && name ? { name: name.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80) } : {}),
          used: window.used_percent,
          duration: Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0 ? window.limit_window_seconds : null,
          resetAt: Number.isFinite(resetAt) && resetAt <= 8.64e15 ? resetAt : null,
        }
      }))
    const plan = typeof body?.plan_type === "string" ? body.plan_type.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) : undefined
    const count = body?.rate_limit_reset_credits?.available_count
    const allowed = typeof body?.rate_limit?.allowed === "boolean" ? body.rate_limit.allowed : undefined
    const limitReached = typeof body?.rate_limit?.limit_reached === "boolean" ? body.rate_limit.limit_reached : undefined
    return { available: windows.length > 0, windows, checkedAt, ...(plan ? { plan } : {}),
      ...(allowed !== undefined ? { allowed } : {}), ...(limitReached !== undefined ? { limitReached } : {}),
      ...(Number.isSafeInteger(count) && count >= 0 ? { resetCredits: count } : {}) }
  } catch {
    options.signal?.throwIfAborted()
    return { available: false, windows: [], checkedAt }
  }
}

export async function releaseIfRecovered(store, snapshot, usage, signal) {
  if (usage?.allowed !== true || usage.limitReached !== false || !snapshot.limitedUntil) return false
  signal?.throwIfAborted()
  return store.update(snapshot.id, (account) => {
    signal?.throwIfAborted()
    if (account.invalid || account.inRotation === false || account.limitedUntil !== snapshot.limitedUntil ||
        (account.failures ?? 0) !== (snapshot.failures ?? 0)) return false
    account.limitedUntil = 0
    account.failures = 0
    return true
  })
}
