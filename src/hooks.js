import { authorizeBrowser, authorizeDevice } from "./oauth.js"
import { createNativeFetch, createRotatingFetch } from "./transport.js"
import { sameAccount } from "./store.js"
import { formatDateTime } from "./control.js"

export function formatStatus(accounts, now = Date.now()) {
  if (!accounts.length) return "No OpenAI OAuth accounts configured."
  return accounts.map((account) => {
    const state = account.invalid ? "login required" : account.limitedUntil > now
      ? `limited until ${formatDateTime(account.limitedUntil)}` : "available"
    return `${account.name}: ${account.inRotation === false ? "not in rotation; " : ""}${state}`
  }).join("\n")
}

export function buildHooks({ store, client, browser = authorizeBrowser, device = authorizeDevice }) {
  async function log(message) {
    try {
      await client?.app?.log({ body: { service: "oc-nonstop-router", level: "info", message } })
    } catch {}
  }

  function oauthMethod(label, authorize) {
    return {
      type: "oauth",
      label,
      prompts: [{ type: "text", key: "name", message: "Name for this account", placeholder: "Personal account" }],
      async authorize(inputs) {
        const flow = await authorize()
        return {
          ...flow,
          async callback(...args) {
            const result = await flow.callback(...args)
            if (result?.type === "success" && result.refresh && result.access) {
              const { type: _type, ...credentials } = result
              const name = typeof inputs?.name === "string" ? inputs.name.trim().slice(0, 80) : undefined
              await store.upsert({ type: "oauth", ...credentials }, name || undefined)
              await log("OpenAI OAuth account added.")
            }
            return result
          },
        }
      },
    }
  }

  return {
    auth: {
      provider: "openai",
      methods: [
        oauthMethod("ChatGPT Pro/Plus (browser) - add account", browser),
        oauthMethod("ChatGPT Pro/Plus (device) - add account", device),
        { type: "api", label: "Enter API key manually" },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        if (await store.isEnabled()) {
          const accounts = await store.list()
          if (!accounts.length) await store.upsert(auth)
          else {
            const match = accounts.find((account) => sameAccount(auth, account.auth))
            if (match && auth.expires > match.auth.expires) {
              await store.update(match.id, (account) => {
                if (auth.expires > account.auth.expires) { account.auth = { ...auth }; delete account.invalid }
              })
            }
          }
        }
        const rotatingFetch = createRotatingFetch(store, {
          disabledFetch: createNativeFetch(store, { getAuth, client }),
          onLimit: (name, reset) => log(`Account ${name} is rate-limited; next attempt after ${new Date(reset).toISOString()}.`),
          onWait: (ms) => log(`All available accounts are rate-limited; checking for recovery while waiting up to ${Math.ceil(ms / 1000)} seconds.`),
          onRecovery: (name) => log(`Account ${name} is available again; resuming the request.`),
        })
        return {
          apiKey: "opencode-oauth-dummy-key",
          async fetch(input, init) {
            if (await store.isEnabled() && (await store.list()).length === 0) {
              const current = await getAuth()
              if (current?.type === "oauth") await store.upsert(current)
            }
            return rotatingFetch(input, init)
          },
        }
      },
    },
    tool: {
      nonstop_router_status: {
        description: "Shows the status of OpenAI OAuth accounts without revealing credentials.",
        args: {},
        async execute() {
          return `Nonstop Router: ${await store.isEnabled() ? "ON" : "OFF"}\n${formatStatus(await store.list())}`
        },
      },
    },
  }
}
