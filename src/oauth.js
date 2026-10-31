import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) } catch { return undefined }
}

function idFromToken(token) {
  const payload = claims(token)
  return payload?.chatgpt_account_id ?? payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? payload?.organizations?.[0]?.id
}

function userFromToken(token) {
  const payload = claims(token)
  return payload?.["https://api.openai.com/auth"]?.chatgpt_user_id ?? payload?.sub
}

function authResult(tokens, fallbackId, fallbackUserId) {
  if (typeof tokens?.access_token !== "string" || !tokens.access_token || typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
    throw new Error("OAuth response does not contain valid credentials")
  }
  const seconds = Number(tokens.expires_in ?? 3600)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid OAuth expiration time")
  const accountId = idFromToken(tokens.id_token) ?? idFromToken(tokens.access_token) ?? fallbackId
  const userId = userFromToken(tokens.id_token) ?? userFromToken(tokens.access_token) ?? fallbackUserId
  return {
    type: "success",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + seconds * 1000,
    ...(accountId ? { accountId } : {}),
    ...(typeof userId === "string" && userId ? { userId } : {}),
  }
}

async function tokenRequest(fetcher, issuer, fields) {
  const response = await fetcher(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: CLIENT_ID }).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const error = new Error(`OAuth authentication failed (HTTP ${response.status})`)
    error.status = response.status
    throw error
  }
  return response.json()
}

export async function refreshIfNeeded(store, id, options = {}) {
  return store.update(id, async (account) => {
    const current = account.auth
    const force = options.rejectedAccess && options.rejectedAccess === current.access
    if (!force && current.expires > Date.now() + 30_000) return { ...current }
    const tokens = await tokenRequest(options.fetch ?? fetch, options.issuer ?? ISSUER, {
      grant_type: "refresh_token",
      refresh_token: current.refresh,
    })
    const { type: _type, ...auth } = authResult(tokens, current.accountId, current.userId)
    account.auth = { type: "oauth", ...auth }
    return { ...account.auth }
  })
}

export async function refreshNative(auth, options = {}) {
  const tokens = await tokenRequest(options.fetch ?? fetch, ISSUER, {
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
  })
  const { type: _type, ...credentials } = authResult(tokens, auth.accountId, auth.userId)
  return { type: "oauth", ...credentials }
}

export async function authorizeDevice(options = {}) {
  options.signal?.throwIfAborted()
  const issuer = options.issuer ?? ISSUER
  const fetcher = options.fetch ?? fetch
  const signal = () => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  const response = await fetcher(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: signal(),
  })
  if (!response.ok) throw new Error(`Could not start device login (HTTP ${response.status})`)
  const device = await response.json()
  if (!device.device_auth_id || !device.user_code) throw new Error("Invalid device login response")
  const interval = Math.max(Number.parseInt(device.interval, 10) || 5, 1) * 1000 + 3000
  return {
    url: `${issuer}/codex/device`,
    instructions: `Open the URL and enter the code: ${device.user_code}`,
    method: "auto",
    async callback() {
      const deadline = Date.now() + 15 * 60_000
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted()
        const result = await fetcher(`${issuer}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
          signal: signal(),
        })
        if (result.ok) {
          const data = await result.json()
          const tokens = await tokenRequest(fetcher, issuer, {
            grant_type: "authorization_code",
            code: data.authorization_code,
            redirect_uri: `${issuer}/deviceauth/callback`,
            code_verifier: data.code_verifier,
          })
          return authResult(tokens)
        }
        if (result.status !== 403 && result.status !== 404) return { type: "failed" }
        await (options.sleep ?? delay)(interval, undefined, { signal: options.signal })
      }
      throw new Error("Timed out authorizing the account")
    },
  }
}

export async function authorizeBrowser(options = {}) {
  options.signal?.throwIfAborted()
  const issuer = options.issuer ?? ISSUER
  const fetcher = options.fetch ?? fetch
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(32).toString("base64url")
  let resolveCallback
  let rejectCallback
  const received = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
  received.catch(() => {})
  let redirectUri
  let completed = false
  let timer
  const abort = () => {
    completed = true
    rejectCallback(options.signal.reason)
    close()
  }
  const close = () => {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
    if (server.listening) server.close()
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname !== "/auth/callback" || completed) {
      response.writeHead(404).end()
      return
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end("Invalid OAuth state")
      return
    }
    completed = true
    response.once("finish", close)
    const code = url.searchParams.get("code")
    if (!code || url.searchParams.has("error")) {
      response.writeHead(400).end("Authorization not completed")
      rejectCallback(new Error("Authorization not completed"))
      return
    }
    try {
      const tokens = await tokenRequest(fetcher, issuer, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      })
      resolveCallback(authResult(tokens))
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Account connected. You can close this window.")
    } catch (error) {
      rejectCallback(error)
      response.writeHead(500).end("Failed to connect the account")
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 1455, "127.0.0.1", resolve)
  })
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) {
    abort()
    options.signal.throwIfAborted()
  }
  redirectUri = `http://localhost:${server.address().port}/auth/callback`
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri,
    scope: "openid profile email offline_access", code_challenge: challenge,
    code_challenge_method: "S256", id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true", state, originator: "opencode",
  })
  timer = setTimeout(() => {
    rejectCallback(new Error("Timed out authorizing the account"))
    close()
  }, options.timeoutMs ?? 5 * 60_000)
  timer.unref?.()
  return {
    url: `${issuer}/oauth/authorize?${params}`,
    instructions: "Complete authorization in your browser.",
    method: "auto",
    async callback() {
      try { return await received } finally { close() }
    },
  }
}
