import { transformFileAsync } from "@babel/core"
import { writeFile } from "node:fs/promises"

const result = await transformFileAsync("./src/tui.tsx", {
  configFile: false,
  babelrc: false,
  presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }], "@babel/preset-typescript"],
})
await writeFile("./src/tui.js", `${result.code}\n`)
