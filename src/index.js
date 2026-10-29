import { buildHooks } from "./hooks.js"
import { createStore } from "./store.js"

export default async function nonstopRouter({ client }) {
  const store = createStore()
  return buildHooks({ store, client })
}
