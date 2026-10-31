import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"

test("OpenCode TUI loads the packaged plugin and handles router commands", { timeout: 120_000, skip: spawnSync("tmux", ["-V"]).error ? "tmux is not installed" : false }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-tui-"))
  const socket = `nonstop-${process.pid}-${Date.now()}`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|^OPENCODE_|^NPM_CONFIG_|^TMUX/i.test(key)))
  Object.assign(env, {
    HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", TERM: "xterm-256color",
  })
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" })
  t.after(async () => {
    try { tmux("kill-server") } catch {}
    if (!process.env.NONSTOP_TEST_DEBUG) await rm(root, { recursive: true, force: true })
  })
  const config = path.join(root, "config", "opencode")
  const data = path.join(root, "data", "opencode")
  const cwd = path.join(root, "workspace")
  await Promise.all([mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(cwd, { recursive: true })])
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { env, encoding: "utf8" }))
  const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  const spec = `oc-nonstop-router@${JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).version}`
  const cache = path.join(root, "cache", "opencode", "packages", spec)
  await mkdir(cache, { recursive: true })
  execFileSync("npm", ["install", "--prefix", cache, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, artifact.filename)], { env })
  await writeFile(path.join(config, "opencode.json"), JSON.stringify({ "$schema": "https://opencode.ai/config.json", plugin: [spec] }))
  await writeFile(path.join(config, "tui.json"), JSON.stringify({ "$schema": "https://opencode.ai/tui.json", plugin: [spec] }))
  const accountDir = path.join(data, "oc-nonstop-router")
  await mkdir(accountDir)
  await writeFile(path.join(accountDir, "accounts.json"), JSON.stringify({ version: 1, accounts: ["One", "Two"].map((name) => ({
    id: name, name, invalid: true, limitedUntil: 0,
    auth: { type: "oauth", accountId: name, access: `fake-access-${name}`, refresh: `fake-refresh-${name}`, expires: Date.now() + 3_600_000 },
  })) }))
  const capture = () => tmux("capture-pane", "-p", "-t", "router")
  const waitFor = async (pattern) => {
    let text = ""
    for (let i = 0; i < 100; i++) {
      text = capture()
      if (pattern.test(text)) return text
      await delay(300)
    }
    assert.match(text, pattern, `TUI did not show ${pattern}; isolated data: ${root}\n${text}`)
  }
  tmux("new-session", "-d", "-x", "120", "-y", "40", "-c", cwd, "-s", "router", "opencode")
  await waitFor(/Nonstop Router: ON/)
  tmux("send-keys", "-t", "router", "-l", "/nonstop disable")
  await delay(300)
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Nonstop Router: OFF/)
  tmux("send-keys", "-t", "router", "-l", "/nonstop config")
  await delay(300)
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Nonstop Router configuration/)
  assert.match(capture(), /Add signed-in OpenCode account/)
  tmux("send-keys", "-t", "router", "-l", "Two")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Move earlier in sequence/)
  tmux("send-keys", "-t", "router", "-l", "Move earlier")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Nonstop Router configuration/)
  const saved = JSON.parse(await readFile(path.join(accountDir, "accounts.json"), "utf8"))
  assert.deepEqual(saved.accounts.map((account) => account.name), ["Two", "One"])
  tmux("send-keys", "-t", "router", "-l", "One")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Rename account/)
  tmux("send-keys", "-t", "router", "-l", "Rename account")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/enter submit/)
  await delay(300)
  tmux("send-keys", "-t", "router", "-l", " Team")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Nonstop Router configuration/)
  const renamed = JSON.parse(await readFile(path.join(accountDir, "accounts.json"), "utf8"))
  assert.equal(renamed.accounts[1].name, "One Team")
  tmux("send-keys", "-t", "router", "-l", "Two")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Remove from sequence/)
  tmux("send-keys", "-t", "router", "-l", "Remove from sequence")
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Nonstop Router configuration/)
  const afterRemoval = JSON.parse(await readFile(path.join(accountDir, "accounts.json"), "utf8"))
  assert.equal(afterRemoval.accounts[0].inRotation, false)
  assert.equal(afterRemoval.accounts[0].auth.refresh, "fake-refresh-Two")
  tmux("send-keys", "-t", "router", "Escape")
  await delay(300)
  tmux("send-keys", "-t", "router", "-l", "/nonstop status")
  await delay(300)
  tmux("send-keys", "-t", "router", "Enter")
  const status = await waitFor(/Two.*not in rotation/)
  assert.doesNotMatch(status, /fake-access|fake-refresh/)
  tmux("send-keys", "-t", "router", "Enter")
  const details = await waitFor(/Available resets: unavailable/)
  assert.match(details, /Daily: unavailable/)
  assert.match(details, /Weekly: unavailable/)
  assert.doesNotMatch(details, /fake-access|fake-refresh/)
  tmux("send-keys", "-t", "router", "Escape")
  await delay(300)
  tmux("send-keys", "-t", "router", "-l", "/nonstop enable")
  await delay(300)
  tmux("send-keys", "-t", "router", "Enter")
  await waitFor(/Nonstop Router: ON/)
})
