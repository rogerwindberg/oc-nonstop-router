import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function identity(auth) {
  let claims
  try { claims = JSON.parse(Buffer.from(auth.access.split(".")[1], "base64url").toString()) } catch {}
  const workspace = auth.accountId ?? claims?.chatgpt_account_id ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id
  const subject = auth.userId ?? claims?.["https://api.openai.com/auth"]?.chatgpt_user_id ?? claims?.sub
  return {
    workspace: typeof workspace === "string" && workspace ? workspace : undefined,
    subject: typeof subject === "string" && subject ? subject : undefined,
  }
}

function accountId(auth) {
  const { workspace, subject } = identity(auth)
  if (subject) return `${workspace || "account"}:${createHash("sha256").update(subject).digest("hex").slice(0, 20)}`
  if (workspace) return workspace
  return `account-${createHash("sha256").update(auth.refresh).digest("hex").slice(0, 24)}`
}

export function sameAccount(left, right) {
  if (typeof left.refresh === "string" && left.refresh && left.refresh === right.refresh) return true
  const a = identity(left)
  const b = identity(right)
  if (a.subject || b.subject) return Boolean(a.subject && b.subject && a.subject === b.subject && a.workspace === b.workspace)
  return Boolean(a.workspace && a.workspace === b.workspace)
}

function validAuth(auth) {
  return auth?.type === "oauth" && typeof auth.access === "string" && auth.access.length > 0 &&
    typeof auth.refresh === "string" && auth.refresh.length > 0 && Number.isFinite(auth.expires) && auth.expires >= 0
}

async function readOptional(file) {
  if (!file) return undefined
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export function createStore(options = {}) {
  const dataRoot = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  const directory = options.directory ?? path.join(dataRoot, "opencode", "oc-nonstop-router")
  const file = path.join(directory, "accounts.json")
  const lock = path.join(directory, ".lock")

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }

  async function readState() {
    const raw = await readOptional(file)
    if (raw === undefined) return { version: 1, accounts: [] }
    const data = JSON.parse(raw)
    if (data?.version !== 1 || !Array.isArray(data.accounts)) throw new Error("Invalid accounts file")
    return data
  }

  async function withLock(fn) {
    await ensureDirectory()
    const handle = await open(lock, "a", 0o600)
    await handle.close()
    await chmod(lock, 0o600)
    const child = spawn("flock", ["-x", "-w", "120", lock, "sh", "-c", "printf 'ready\\n'; read -r _ || :"], {
      stdio: ["pipe", "pipe", "ignore"],
    })
    await new Promise((resolve, reject) => {
      let acquired = false
      child.once("error", reject)
      child.once("exit", (code) => { if (!acquired) reject(new Error(`Failed to lock accounts (flock: ${code})`)) })
      child.stdout.once("data", () => { acquired = true; resolve() })
    })
    try {
      return await fn()
    } finally {
      const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined
      child.stdin.end("done\n")
      if (exited) await exited
    }
  }

  async function writeState(data) {
    await atomicWrite(file, JSON.stringify(data, null, 2))
  }

  function mergeAccount(data, auth, name) {
    if (!validAuth(auth)) return false
    const { workspace, subject } = identity(auth)
    auth = { ...auth, ...(workspace ? { accountId: workspace } : {}), ...(subject ? { userId: subject } : {}) }
    const id = accountId(auth)
    const existing = data.accounts.find((item) => item.id === id ||
      (subject && identity(item.auth).workspace === workspace && identity(item.auth).subject === subject))
    if (existing) {
      existing.auth = { ...auth }
      delete existing.invalid
      if (name) existing.name = name
    } else {
      data.accounts.push({ id, name: name || `Account ${data.accounts.length + 1}`, auth: { ...auth }, limitedUntil: 0 })
    }
    return true
  }

  return {
    directory,
    async list() {
      return (await readState()).accounts
    },
    async isEnabled() {
      return (await readState()).enabled !== false
    },
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Invalid router state")
      return withLock(async () => {
        const state = await readState()
        state.enabled = enabled
        await writeState(state)
      })
    },
    async rename(id, name) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("Invalid account name")
      return this.update(id, (account) => { account.name = name.trim() })
    },
    async move(id, direction) {
      if (direction !== -1 && direction !== 1) throw new Error("Invalid direction")
      return withLock(async () => {
        const state = await readState()
        const index = state.accounts.findIndex((account) => account.id === id)
        if (index < 0) throw new Error("Account not found")
        if (state.accounts[index].inRotation === false) return
        let target = index + direction
        while (target >= 0 && target < state.accounts.length && state.accounts[target].inRotation === false) target += direction
        if (target >= 0 && target < state.accounts.length) {
          ;[state.accounts[index], state.accounts[target]] = [state.accounts[target], state.accounts[index]]
          await writeState(state)
        }
      })
    },
    async setInRotation(id, included) {
      if (typeof included !== "boolean") throw new Error("Invalid account state")
      return withLock(async () => {
        const state = await readState()
        const index = state.accounts.findIndex((account) => account.id === id)
        if (index < 0) throw new Error("Account not found")
        const account = state.accounts[index]
        const wasExcluded = account.inRotation === false
        account.inRotation = included
        if (included && wasExcluded) state.accounts.push(...state.accounts.splice(index, 1))
        await writeState(state)
      })
    },
    async upsert(auth, name) {
      if (!validAuth(auth)) throw new Error("Invalid OpenAI OAuth credentials")
      return withLock(async () => {
        const state = await readState()
        mergeAccount(state, auth, name)
        await writeState(state)
        return accountId(auth)
      })
    },
    async update(id, fn) {
      return withLock(async () => {
        const state = await readState()
        const account = state.accounts.find((item) => item.id === id)
        if (!account) throw new Error("Account not found")
        const result = await fn(account)
        await writeState(state)
        return result
      })
    },
  }
}
