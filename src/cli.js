#!/usr/bin/env node
import { formatStatus } from "./hooks.js"
import { formatError } from "./control.js"
import { createStore } from "./store.js"

if (process.argv[2] !== "status") {
  console.error("Usage: nonstop-router status")
  process.exitCode = 1
} else {
  try {
    const store = createStore()
    console.log(`Nonstop Router: ${await store.isEnabled() ? "ON" : "OFF"}\n${formatStatus(await store.list())}`)
  } catch (error) {
    console.error(`Unable to check accounts: ${formatError(error)}`)
    process.exitCode = 1
  }
}
