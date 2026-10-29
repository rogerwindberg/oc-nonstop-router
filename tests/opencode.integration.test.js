import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { test } from "node:test"

test("OpenCode installs the package and exposes its OAuth methods in an isolated environment", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-integration-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, "config", "opencode")
  const data = path.join(root, "data", "opencode")
  const cwd = path.join(root, "workspace")
  await Promise.all([mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(cwd, { recursive: true })])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|^OPENCODE_|^NPM_CONFIG_/i.test(key)))
  Object.assign(env, {
    HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  })
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { env, encoding: "utf8" }))
  const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  const plugin = `oc-nonstop-router@file:${path.join(root, artifact.filename)}`
  await writeFile(path.join(config, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    plugin: [plugin],
    provider: { openai: { options: { headerTimeout: false, timeout: false } } },
  }))
  await writeFile(path.join(data, "auth.json"), JSON.stringify({
    openai: { type: "oauth", accountId: "test-account", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 3_600_000 },
  }), { mode: 0o600 })
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))])
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  })
  let output = ""
  child.stderr.on("data", (chunk) => { output += chunk.toString() })
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Servidor OpenCode não iniciou: ${output}`)), 30_000)
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
      const found = output.match(/https?:\/\/127\.0\.0\.1:\d+/)
      if (found) { clearTimeout(timer); resolve(found[0]) }
    })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`OpenCode saiu com ${code}: ${output}`)) })
  })
  const methodsResponse = await fetch(`${address}/provider/auth`, { signal: AbortSignal.timeout(90_000) })
  assert.equal(methodsResponse.status, 200)
  const methods = await methodsResponse.json()
  assert.ok(methods.openai.some((method) => method.label.includes("add account")))
  const tools = await (await fetch(`${address}/experimental/tool/ids`)).json()
  assert.ok(tools.includes("nonstop_router_status"))
  const resolvedConfig = await (await fetch(`${address}/config`)).json()
  assert.equal(resolvedConfig.provider.openai.options.headerTimeout, false)
  assert.equal(resolvedConfig.provider.openai.options.timeout, false)
  assert.equal((await fetch(`${address}/provider`)).status, 200)
  const saved = JSON.parse(await readFile(path.join(data, "oc-nonstop-router", "accounts.json"), "utf8"))
  assert.equal(saved.accounts.length, 1)
  assert.equal(saved.accounts[0].id, "test-account")
  assert.equal(saved.accounts[0].auth.refresh, "dummy-refresh")
})
