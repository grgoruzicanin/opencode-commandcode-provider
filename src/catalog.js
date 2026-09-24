import { gunzipSync } from "node:zlib"
import { asNumber, asRecord, asString, fetchJson } from "./util.js"

const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])
const PLAN_RANK = { go: 0, goat: 1, pro: 2, max: 3 }
const MODELS_REFERENCE_PATH = "package/dist/bundled/command-code-knowledge/reference/models.md"
const CLI_BUNDLE_PATH = "package/dist/cli.mjs"
const TEXT_ONLY_MARKER = ',__name(isKnownTextOnlyModel,"isKnownTextOnlyModel")'

export function configKey(modelID) {
  return modelID.slice(modelID.lastIndexOf("/") + 1).toLowerCase()
}

export async function fetchLiveModels(modelsURL) {
  const body = await fetchJson(modelsURL, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
  })
  if (body?.object !== "list" || !Array.isArray(body.data) || body.data.length === 0) {
    throw new Error("Command Code returned an invalid or empty model catalog")
  }
  return body.data.filter((model) => {
    const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : []
    // `typesafe/jev` is a decision model, not a conversational model.
    return model?.id !== "typesafe/jev" && !(
      endpoints.length > 0 && endpoints.every((endpoint) => String(endpoint).includes("systemone"))
    )
  })
}

function tarString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const zero = slice.indexOf(0)
  return slice.subarray(0, zero >= 0 ? zero : slice.length).toString("utf8").trim()
}

export function extractTarEntries(gzipBuffer, wanted) {
  const tar = gunzipSync(gzipBuffer)
  const output = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const sizeLiteral = tarString(header, 124, 12).replace(/\0/g, "").trim()
    const size = parseInt(sizeLiteral || "0", 8)
    if (!Number.isFinite(size) || size < 0) throw new Error(`Invalid tar entry size for ${path}`)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error(`Truncated tar entry: ${path}`)
    if (wanted.has(path)) output.set(path, tar.subarray(dataStart, dataEnd))
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return output
}

export async function fetchOfficialPackage(registryBase) {
  const metadata = await fetchJson(`${registryBase}/command-code/latest?cacheBust=${Date.now()}`, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
  })
  const version = asString(metadata?.version)
  const tarball = asString(metadata?.dist?.tarball)
  if (!version || !tarball) throw new Error("Command Code npm metadata is missing version or tarball")
  const response = await fetch(tarball, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Command Code package download returned ${response.status}`)
  const entries = extractTarEntries(Buffer.from(await response.arrayBuffer()), new Set([
    MODELS_REFERENCE_PATH,
    CLI_BUNDLE_PATH,
  ]))
  const modelsReference = entries.get(MODELS_REFERENCE_PATH)?.toString("utf8")
  const cliBundle = entries.get(CLI_BUNDLE_PATH)?.toString("utf8")
  if (!modelsReference || !cliBundle) throw new Error("Command Code package no longer contains expected model metadata")
  return { version, modelsReference, cliBundle }
}

export function parseModelReference(markdown) {
  const catalog = new Map()
  for (const line of markdown.split("\n")) {
    if (!line.includes("| `")) continue
    const columns = line.split("|").map((column) => column.trim())
    const id = columns.map((column) => /^`([^`]+)`$/.exec(column)?.[1]).find(Boolean)
    if (!id) continue

    const priceColumn = columns.find((column) => /^\$[\d.]+\/\$[\d.]+ · cache \$[\d.]+/.test(column))
    const price = priceColumn
      ? /^\$([\d.]+)\/\$([\d.]+) · cache \$([\d.]+)(?: \(write \$([\d.]+)\))?$/.exec(priceColumn)
      : undefined
    const planColumn = columns.find((column) => /^(Go|GOAT|Pro|Max)(?: and above)?$/i.test(column))
    const effortColumn = columns.find((column) => {
      if (column === "—") return true
      const values = column.split(",").map((value) => value.trim()).filter(Boolean)
      return values.length > 0 && values.every((value) => VALID_EFFORTS.has(value))
    })
    const efforts = effortColumn && effortColumn !== "—"
      ? effortColumn.split(",").map((value) => value.trim()).filter((value) => VALID_EFFORTS.has(value))
      : []
    if (!price || !planColumn) continue
    catalog.set(id, {
      efforts,
      minimumPlan: planColumn.split(/\s+/)[0].toLowerCase(),
      cost: {
        input: Number(price[1]),
        output: Number(price[2]),
        cacheRead: Number(price[3]),
        cacheWrite: Number(price[4] ?? 0),
      },
    })
  }
  return catalog
}

function parseKnownTextOnlyModels(bundle) {
  const markerIndex = bundle.indexOf(TEXT_ONLY_MARKER)
  if (markerIndex < 0) return new Set()
  const setStart = bundle.lastIndexOf("new Set([", markerIndex)
  if (setStart < 0) return new Set()
  try {
    const literal = bundle.slice(setStart + "new Set(".length, markerIndex - 1)
    const ids = JSON.parse(literal)
    return Array.isArray(ids) ? new Set(ids.filter((id) => typeof id === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function modelObject(bundle, modelID) {
  const start = bundle.indexOf(`{id:${JSON.stringify(modelID)},inputModalities:`)
  if (start < 0) return undefined
  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = start; index < bundle.length; index += 1) {
    const character = bundle[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") quote = character
    else if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) return bundle.slice(start, index + 1)
  }
  return undefined
}

export function parseCapabilities(bundle, modelIDs) {
  const textOnly = parseKnownTextOnlyModels(bundle)
  const capabilities = new Map()
  for (const modelID of modelIDs) {
    const entry = modelObject(bundle, modelID)
    const maxOutputLiteral = entry ? /maxOutputTokens:([^,}]+)/.exec(entry)?.[1] : undefined
    const parsedOutput = maxOutputLiteral === undefined ? undefined : Number(maxOutputLiteral)
    capabilities.set(modelID, {
      reasoning: Boolean(entry && (entry.includes("reasoning:!0") || entry.includes("reasoningEfforts:["))),
      input: textOnly.has(modelID) ? ["text"] : ["text", "image"],
      maxOutputTokens: Number.isFinite(parsedOutput) && parsedOutput > 0 ? parsedOutput : 65_536,
    })
  }
  return capabilities
}

export function buildMetadata(packageData, liveModels) {
  const catalog = parseModelReference(packageData.modelsReference)
  const capabilities = parseCapabilities(packageData.cliBundle, liveModels.map((model) => model.id))
  const models = {}
  for (const live of liveModels) {
    const meta = catalog.get(live.id)
    const capability = capabilities.get(live.id)
    models[live.id] = {
      minimumPlan: meta?.minimumPlan,
      efforts: meta?.efforts ?? [],
      cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Unknown/new models default to text-only. Advertising image support
      // when it is not known causes OpenCode to send inputs the backend may
      // reject; the live API can override this below when it exposes modalities.
      input: capability?.input ?? ["text"],
      maxOutputTokens: capability?.maxOutputTokens ?? 65_536,
    }
  }
  return { version: packageData.version, models }
}

export function filterLiveModels(liveModels, metadata, plan, mode) {
  if (mode === "full") return liveModels
  if (!plan) return liveModels
  if (!Number.isFinite(plan.rank)) return liveModels
  return liveModels.filter((model) => {
    const minimumPlan = metadata?.models?.[model.id]?.minimumPlan
    const rank = minimumPlan ? PLAN_RANK[minimumPlan] : undefined
    // New upstream models should appear immediately even if npm enrichment has
    // not caught up yet. The Command Code backend remains the entitlement gate.
    return rank === undefined || rank <= plan.rank
  })
}

function modelContext(live) {
  return asNumber(live?.context_length) ?? asNumber(live?.contextLength) ?? 65_536
}

function liveInputModalities(live) {
  const input = live?.modalities?.input ?? live?.input_modalities ?? live?.inputModalities
  if (!Array.isArray(input)) return undefined
  const normalized = input
    .map((value) => String(value).toLowerCase())
    .filter((value) => value === "text" || value === "image")
  return normalized.length ? [...new Set(normalized)] : undefined
}

function modelOutputLimit(live, meta) {
  return asNumber(live?.max_output_tokens)
    ?? asNumber(live?.maxOutputTokens)
    ?? asNumber(meta?.maxOutputTokens)
    ?? 65_536
}

function modelReleaseTime(live) {
  const value = asNumber(live?.created) ?? asNumber(live?.created_at) ?? asNumber(live?.createdAt)
  if (!value || value < 0) return 0
  // OpenAI-style model catalogs commonly expose Unix seconds while OpenCode's
  // model registry uses JS timestamps. Accept either without guessing upstream.
  return value < 1_000_000_000_000 ? value * 1000 : value
}

export function toOpenCodeModels(liveModels, metadata) {
  const result = []
  const keys = new Set()
  for (const live of liveModels) {
    const id = asString(live?.id)
    if (!id) continue
    const key = configKey(id)
    if (keys.has(key)) {
      // Rare short-name collisions fall back to a stable full-id key instead of
      // dropping one model from /models.
      result.push(toOpenCodeModel(live, metadata, id.toLowerCase()))
      continue
    }
    keys.add(key)
    result.push(toOpenCodeModel(live, metadata, key))
  }
  return result
}

function toOpenCodeModel(live, metadata, key) {
  const id = String(live.id)
  const meta = metadata?.models?.[id] ?? {}
  const context = Math.max(1, modelContext(live))
  const maxOutput = Math.max(1, modelOutputLimit(live, meta))
  const input = liveInputModalities(live)
    ?? (Array.isArray(meta.input) && meta.input.length ? meta.input : ["text"])
  return {
    id: key,
    modelID: id,
    providerID: "commandcode",
    name: asString(live.name) ?? id,
    capabilities: {
      tools: true,
      input,
      output: ["text"],
    },
    variants: Array.isArray(meta.efforts)
      ? meta.efforts.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }))
      : [],
    time: { released: modelReleaseTime(live) },
    cost: [{
      input: Number(meta.cost?.input ?? 0),
      output: Number(meta.cost?.output ?? 0),
      cache: {
        read: Number(meta.cost?.cacheRead ?? 0),
        write: Number(meta.cost?.cacheWrite ?? 0),
      },
    }],
    status: "active",
    enabled: true,
    limit: { context, output: Math.min(context, maxOutput) },
  }
}

export function serializeMetadata(metadata) {
  return metadata && typeof metadata === "object" ? metadata : undefined
}

export function deserializeMetadata(value) {
  const record = asRecord(value)
  if (!record || typeof record.version !== "string" || !asRecord(record.models)) return undefined
  return record
}
