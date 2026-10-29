import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

test("uses its own account directory without altering another plugin's data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-nonstop-router-isolation-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const otherFile = path.join(root, ".config", "opencode", "oc-nonstop-router-other", "accounts.json")
  await mkdir(path.dirname(otherFile), { recursive: true })
  const otherData = JSON.stringify({ providerAccounts: { openai: [{ type: "oauth", access: "other-access", refresh: "other-refresh", expires: 10 }] } })
  await writeFile(otherFile, otherData)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|^OPENCODE_/i.test(key)))
  Object.assign(env, { HOME: root, XDG_DATA_HOME: path.join(root, "data") })
  const plugin = new URL("../src/index.js", import.meta.url).href
  const store = new URL("../src/store.js", import.meta.url).href
  const script = `import plugin from ${JSON.stringify(plugin)}; import { createStore } from ${JSON.stringify(store)}; await plugin({}); await createStore().upsert({type:'oauth', accountId:'new-account', access:'access', refresh:'refresh', expires:100})`
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { env })
  assert.equal(existsSync(otherFile), true)
  assert.equal(await readFile(otherFile, "utf8"), otherData)
  assert.deepEqual(await readdir(path.join(root, "data", "opencode")), ["oc-nonstop-router"])
  const saved = JSON.parse(await readFile(path.join(root, "data", "opencode", "oc-nonstop-router", "accounts.json"), "utf8"))
  assert.deepEqual(saved.accounts.map((account) => account.id), ["new-account"])
})
