#!/usr/bin/env node
import { formatStatus } from "./hooks.js"
import { createStore } from "./store.js"

if (process.argv[2] !== "status") {
  console.error("Usage: nonstop-router status")
  process.exitCode = 1
} else {
  try {
    console.log(formatStatus(await createStore().list()))
  } catch (error) {
    console.error(`Unable to check accounts: ${error.message}`)
    process.exitCode = 1
  }
}
