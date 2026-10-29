import { authorizeBrowser, authorizeDevice } from "./oauth.js"
import { createRotatingFetch } from "./transport.js"

export function formatStatus(accounts, now = Date.now()) {
  if (!accounts.length) return "No OpenAI OAuth accounts configured."
  return accounts.map((account) => {
    const state = account.invalid ? "login required" : account.limitedUntil > now
      ? `limited until ${new Date(account.limitedUntil).toISOString()}` : "available"
    return `${account.name}: ${state}`
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
        if ((await store.list()).length === 0) await store.upsert(auth)
        return {
          apiKey: "opencode-oauth-dummy-key",
          fetch: createRotatingFetch(store, {
            onLimit: (name, reset) => log(`Account ${name} is rate-limited; next attempt after ${new Date(reset).toISOString()}.`),
            onWait: (ms) => log(`All available accounts are rate-limited; waiting approximately ${Math.ceil(ms / 1000)} seconds.`),
          }),
        }
      },
    },
    tool: {
      nonstop_router_status: {
        description: "Shows the status of OpenAI OAuth accounts without revealing credentials.",
        args: {},
        async execute() {
          return formatStatus(await store.list())
        },
      },
    },
  }
}
