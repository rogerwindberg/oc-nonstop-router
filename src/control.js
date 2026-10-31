import { readUsage, releaseIfRecovered } from "./usage.js"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sameAccount } from "./store.js"

export function parseCommand(input) {
  return /^\/nonstop\s+(enable|disable|config|status)\s*$/i.exec(input)?.[1].toLowerCase()
}

export function formatError(error) {
  const messages = [
    "Invalid account name",
    "Account not found",
    "No OpenAI OAuth account is signed in to OpenCode",
    "Cannot read OpenCode authentication",
    "Invalid accounts file",
    "Authorization failed",
    "Timed out authorizing the account",
    "Could not activate OpenAI in OpenCode",
  ]
  if (messages.includes(error?.message)) return error.message
  if (/^OAuth authentication failed \(HTTP \d{3}\)$/.test(error?.message ?? "")) return error.message
  if (error?.code === "EADDRINUSE") return "The local authorization port is already in use."
  if (error?.code === "EACCES" || error?.code === "EPERM") return "Permission denied. Check the file permissions."
  return "Operation failed. Please try again."
}

function windowName(seconds) {
  if (!Number.isFinite(seconds)) return "Usage"
  if (seconds >= 82_080 && seconds <= 90_720) return "Daily"
  if (seconds >= 574_560 && seconds <= 635_040) return "Weekly"
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`
  if (seconds % 60 === 0) return `${seconds / 60}-minute`
  return `${seconds}-second`
}

export function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "unknown"
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "unknown"
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${month}/${day} ${hours}:${minutes}`
}

export function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "unknown"
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "unknown"
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

export function formatUsage(usage) {
  const windows = usage?.windows ?? []
  const lines = windows.map((window) => {
    const reset = Number.isFinite(window.resetAt) ? ` (resets ${formatDateTime(window.resetAt)})` : ""
    return `${window.name ? `${window.name} ` : ""}${windowName(window.duration)}: ${window.used}% used${reset}`
  })
  for (const label of ["Daily", "Weekly"]) {
    if (!windows.some((window) => !window.name && windowName(window.duration) === label)) lines.push(`${label}: unavailable`)
  }
  if (usage?.plan) lines.push(`Plan: ${usage.plan}`)
  lines.push(`Available resets: ${Number.isSafeInteger(usage?.resetCredits) ? usage.resetCredits : "unavailable"}`)
  if (Number.isFinite(usage?.checkedAt) && Math.abs(usage.checkedAt) <= 8.64e15) lines.push(`Checked: ${formatDateTime(usage.checkedAt)}`)
  return lines.join("\n")
}

export function getFooterSummaryData(account, usage) {
  const windows = usage?.windows ?? []
  const window5h = windows.find((w) => !w.name && windowName(w.duration) === "5-hour")
  const windowWeekly = windows.find((w) => !w.name && windowName(w.duration) === "Weekly")

  const items = []
  if (window5h) {
    items.push({
      label: "5-hour: ",
      used: window5h.used,
      usedText: `${window5h.used}% used`,
      resetText: Number.isFinite(window5h.resetAt) ? ` (resets ${formatDateTime(window5h.resetAt)})` : "",
    })
  }
  if (windowWeekly) {
    items.push({
      label: "Weekly: ",
      used: windowWeekly.used,
      usedText: `${windowWeekly.used}% used`,
      resetText: Number.isFinite(windowWeekly.resetAt) ? ` (resets ${formatDateTime(windowWeekly.resetAt)})` : "",
    })
  }

  const resetsText = `Available resets: ${Number.isSafeInteger(usage?.resetCredits) ? usage.resetCredits : "unavailable"}`
  const lastCheckText = Number.isFinite(usage?.checkedAt) ? `Last check: ${formatTime(usage.checkedAt)}` : undefined

  return {
    accountName: account?.name ?? "",
    items,
    resetsText,
    lastCheckText,
  }
}

export function formatFooterSummary(account, usage) {
  const data = getFooterSummaryData(account, usage)
  const parts = []
  for (const item of data.items) {
    parts.push(`${item.label}${item.usedText}${item.resetText}`)
  }
  parts.push(data.resetsText)
  if (data.lastCheckText) parts.push(data.lastCheckText)
  return `Usage for ${data.accountName}: ${parts.join(" · ")}`
}

export function createController(store, options = {}) {
  const usage = options.usage ?? readUsage
  async function nativeAuth() {
    const root = options.dataRoot ?? (process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"))
    let raw
    try {
      raw = options.dataRoot ? await readFile(path.join(root, "opencode", "auth.json"), "utf8")
        : process.env.OPENCODE_AUTH_CONTENT || await readFile(path.join(root, "opencode", "auth.json"), "utf8")
    } catch (error) {
      if (error.code === "ENOENT") return undefined
      throw error
    }
    try { return JSON.parse(raw).openai } catch { throw new Error("Cannot read OpenCode authentication") }
  }
  return {
    async setEnabled(enabled) { await store.setEnabled(enabled) },
    nativeAuth,
    async addNative() {
      const auth = await nativeAuth()
      if (auth?.type !== "oauth") throw new Error("No OpenAI OAuth account is signed in to OpenCode")
      const existing = (await store.list()).find((account) => sameAccount(auth, account.auth))
      if (existing) {
        if (auth.expires > existing.auth.expires) {
          await store.update(existing.id, (account) => {
            if (auth.expires > account.auth.expires) { account.auth = { ...auth }; delete account.invalid }
          })
        }
        if (existing.inRotation === false) await store.setInRotation(existing.id, true)
      } else {
        await store.upsert(auth)
      }
    },
    async status() {
      const enabled = await store.isEnabled()
      const accounts = await store.list()
      const rows = await Promise.all(accounts.map(async (account, index) => {
        const result = account.invalid ? { available: false, windows: [] } : await usage(store, account.id)
        const recovered = await releaseIfRecovered(store, account, result)
        const name = account.name.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        const state = account.invalid ? "login required" : !recovered && account.limitedUntil > Date.now()
          ? `limited until ${formatDateTime(account.limitedUntil)}` : "available"
        return `${index + 1}. ${name} — ${account.inRotation === false ? "not in rotation · " : ""}${state}\n${formatUsage(result)}`
      }))
      return [`Nonstop Router: ${enabled ? "ON" : "OFF"}`, ...(rows.length ? rows : ["No OpenAI OAuth accounts configured."])].join("\n\n")
    },
  }
}
