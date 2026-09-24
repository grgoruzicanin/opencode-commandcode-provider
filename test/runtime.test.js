import assert from "node:assert/strict"
import test from "node:test"
import { createCommandCode } from "../src/runtime.js"

test("runtime resolves credentials and Command Code version at request time", async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  let key = "first-key"
  let version = "1.0.0"
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) })
    return new Response([
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "text-start", id: "t" }),
      JSON.stringify({ type: "text-delta", id: "t", text: "ok" }),
      JSON.stringify({ type: "text-end", id: "t" }),
      JSON.stringify({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }),
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    })
  }
  try {
    const sdk = createCommandCode({
      apiKey: async () => key,
      commandCodeVersion: () => version,
    })
    const model = sdk.languageModel("vendor/model")
    const options = { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
    const first = await model.doGenerate(options)
    assert.equal(first.content[0].text, "ok")
    assert.equal(seen[0].headers.get("authorization"), "Bearer first-key")
    assert.equal(seen[0].headers.get("x-command-code-version"), "1.0.0")

    key = "second-key"
    version = "2.0.0"
    await model.doGenerate(options)
    assert.equal(seen[1].headers.get("authorization"), "Bearer second-key")
    assert.equal(seen[1].headers.get("x-command-code-version"), "2.0.0")
  } finally {
    globalThis.fetch = originalFetch
  }
})
