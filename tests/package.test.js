import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

test("the installed package exports the plugin and shows status without credentials", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-package-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|^OPENCODE_|^NPM_CONFIG_/i.test(key)))
  Object.assign(env, { HOME: root, XDG_DATA_HOME: path.join(root, "data"), npm_config_cache: path.join(root, "cache") })
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { env, encoding: "utf8" }))
  const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  execFileSync("npm", ["install", "--prefix", root, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, artifact.filename)], { env })
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", "import plugin from 'oc-nonstop-router'; console.log(typeof plugin)"], { cwd: root, env, encoding: "utf8" })
  assert.equal(result.trim(), "function")
  const status = execFileSync(path.join(root, "node_modules", ".bin", "nonstop-router"), ["status"], { cwd: root, env, encoding: "utf8" })
  assert.match(status, /No OpenAI OAuth accounts configured/)
})
