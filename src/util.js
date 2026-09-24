export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

export function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function nonNegativeNumber(value) {
  const number = asNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

export function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function fetchJson(url, init = {}, timeoutMs = 15_000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const response = await fetch(url, { ...init, signal })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const detail = asString(body?.error?.message) ?? asString(body?.message) ?? text.trim()
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`)
  }
  return body
}

export function formatTimestamp(value) {
  if (!value) return "never"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
}

export function normalizePromptArgument(prompt) {
  const text = typeof prompt?.text === "string" ? prompt.text.trim() : ""
  return text.replace(/^\/commandcode-models\b/i, "").trim().toLowerCase()
}
