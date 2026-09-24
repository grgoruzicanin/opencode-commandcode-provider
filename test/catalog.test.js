import assert from "node:assert/strict"
import test from "node:test"
import { gzipSync } from "node:zlib"
import {
  configKey,
  extractTarEntries,
  filterLiveModels,
  parseModelReference,
  toOpenCodeModels,
} from "../src/catalog.js"
import { normalizePlan } from "../src/account.js"

function tarEntry(name, contents) {
  const body = Buffer.from(contents)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  header.write("0000777\0", 100, 8, "ascii")
  header.write("0000000\0", 108, 8, "ascii")
  header.write("0000000\0", 116, 8, "ascii")
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii")
  header.write("00000000000\0", 136, 12, "ascii")
  header.fill(0x20, 148, 156)
  header.write("0", 156, 1, "ascii")
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

test("configKey keeps legacy short model IDs", () => {
  assert.equal(configKey("moonshotai/Kimi-K3"), "kimi-k3")
  assert.equal(configKey("gpt-6-sol"), "gpt-6-sol")
})

test("subscription filtering respects minimum plan and keeps unknown new models", () => {
  const live = [{ id: "a" }, { id: "b" }, { id: "new" }]
  const metadata = { models: { a: { minimumPlan: "go" }, b: { minimumPlan: "max" } } }
  const go = normalizePlan("individual-go")
  assert.deepEqual(filterLiveModels(live, metadata, go, "subscription").map((m) => m.id), ["a", "new"])
  assert.deepEqual(filterLiveModels(live, metadata, go, "full").map((m) => m.id), ["a", "b", "new"])
})

test("model reference parser reads price, efforts, and plan", () => {
  const markdown = [
    "| Model | Name | Caps | Reasoning | Price | Plan |",
    "| `vendor/model-a` | Model A | text | low, high | $1.25/$5.00 · cache $0.10 (write $0.20) | Pro and above |",
  ].join("\n")
  const parsed = parseModelReference(markdown)
  assert.deepEqual(parsed.get("vendor/model-a"), {
    efforts: ["low", "high"],
    minimumPlan: "pro",
    cost: { input: 1.25, output: 5, cacheRead: 0.1, cacheWrite: 0.2 },
  })
})

test("tar extraction works without an external tar command", () => {
  const archive = gzipSync(Buffer.concat([
    tarEntry("package/a.txt", "alpha"),
    tarEntry("package/b.txt", "beta"),
    Buffer.alloc(1024),
  ]))
  const files = extractTarEntries(archive, new Set(["package/b.txt"]))
  assert.equal(files.get("package/b.txt").toString("utf8"), "beta")
  assert.equal(files.has("package/a.txt"), false)
})

test("OpenCode model mapping preserves wire model ID", () => {
  const live = [{ id: "vendor/Model-A", name: "Model A", context_length: 100000 }]
  const metadata = {
    models: {
      "vendor/Model-A": {
        efforts: ["high"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        input: ["text"],
        maxOutputTokens: 8192,
      },
    },
  }
  const [model] = toOpenCodeModels(live, metadata)
  assert.equal(model.id, "model-a")
  assert.equal(model.modelID, "vendor/Model-A")
  assert.equal(model.limit.context, 100000)
  assert.equal(model.limit.output, 8192)
  assert.deepEqual(model.variants, [{ id: "high", settings: { reasoningEffort: "high" } }])
})

test("live model fields override enrichment metadata and normalize timestamps", () => {
  const live = [{
    id: "vendor/model-live",
    name: "Live Model",
    context_length: 200000,
    max_output_tokens: 32768,
    modalities: { input: ["text", "image"], output: ["text"] },
    created: 1_700_000_000,
  }]
  const metadata = {
    models: {
      "vendor/model-live": {
        efforts: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        input: ["text"],
        maxOutputTokens: 8192,
      },
    },
  }
  const [model] = toOpenCodeModels(live, metadata)
  assert.equal(model.limit.output, 32768)
  assert.deepEqual(model.capabilities.input, ["text", "image"])
  assert.equal(model.time.released, 1_700_000_000_000)
})

test("unknown live models use conservative text-only capabilities", () => {
  const [model] = toOpenCodeModels([{ id: "vendor/new-model", context_length: 64000 }], undefined)
  assert.deepEqual(model.capabilities.input, ["text"])
})
