import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.js"
import { STORAGE_METADATA } from "../src/constants.js"

function registration() {
  return { async dispose() {} }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("plugin publishes subscription models and switches to full mode natively", async () => {
  const originalFetch = globalThis.fetch
  const storage = new Map()
  storage.set(STORAGE_METADATA, {
    version: "9.9.9",
    fetchedAt: Date.now(),
    models: {
      "vendor/go-model": {
        minimumPlan: "go",
        efforts: [],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        input: ["text"],
        maxOutputTokens: 4096,
      },
      "vendor/max-model": {
        minimumPlan: "max",
        efforts: [],
        cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
        input: ["text"],
        maxOutputTokens: 4096,
      },
    },
  })

  globalThis.fetch = async (url) => {
    const value = String(url)
    if (value.includes("/provider/v1/models")) {
      return jsonResponse({
        object: "list",
        data: [
          { id: "vendor/go-model", name: "Go Model", context_length: 32000, supported_endpoints: ["/v1/chat/completions"] },
          { id: "vendor/max-model", name: "Max Model", context_length: 32000, supported_endpoints: ["/v1/chat/completions"] },
        ],
      })
    }
    if (value.includes("/alpha/whoami")) return jsonResponse({ org: { id: "org_1" }, user: { name: "Tester" } })
    if (value.includes("/alpha/billing/subscriptions")) {
      return jsonResponse({ data: { planId: "individual-go", status: "active" } })
    }
    throw new Error(`Unexpected fetch: ${value}`)
  }

  let providerTransform
  let providerRecord
  const commands = new Map()
  const synthetic = []
  const hooks = []
  const ctx = {
    options: { refreshIntervalMs: 60 * 60_000 },
    storage: {
      async get(key) { return storage.get(key) },
      async set(key, value) { storage.set(key, value) },
    },
    integration: {
      transform: async (callback) => {
        callback({
          update(_id, fn) { fn({}) },
          method: { update() {} },
        })
        return registration()
      },
      connection: {
        async active() { return { id: "connection_1", integrationID: "commandcode" } },
        async resolve() { return { type: "key", key: "test-key" } },
      },
    },
    provider: {
      transform: async (callback) => { providerTransform = callback; return registration() },
      async reload() {
        const editor = {
          remove() { providerRecord = undefined },
          add(value) { providerRecord = value },
        }
        providerTransform(editor)
      },
    },
    aisdk: {
      hook: async (kind, callback) => { hooks.push([kind, callback]); return registration() },
    },
    command: {
      transform: async (callback) => {
        callback({ add(definition) { commands.set(definition.name, definition) } })
        return registration()
      },
    },
    session: {
      async synthetic(value) { synthetic.push(value) },
    },
  }

  let cleanup
  try {
    cleanup = await plugin.setup(ctx)
    assert.equal(providerRecord.info.id, "commandcode")
    assert.deepEqual(providerRecord.models.map((model) => model.modelID), ["vendor/go-model"])
    assert.ok(commands.has("commandcode-usage"))
    assert.ok(commands.has("commandcode-models"))
    assert.deepEqual(hooks.map(([kind]) => kind), ["sdk", "language"])

    await commands.get("commandcode-models").execute({
      sessionID: "ses_test",
      prompt: { text: "full" },
      delivery: "steer",
    })
    assert.deepEqual(providerRecord.models.map((model) => model.modelID), ["vendor/go-model", "vendor/max-model"])
    assert.equal(storage.get("settings/v1").modelMode, "full")
    assert.match(synthetic.at(-1).description, /Mode: full/)
    assert.equal(synthetic.at(-1).resume, false)
  } finally {
    if (cleanup) await cleanup()
    globalThis.fetch = originalFetch
  }
})
