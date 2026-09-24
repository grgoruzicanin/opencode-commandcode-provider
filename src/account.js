import { asNumber, asRecord, asString, fetchJson, nonNegativeNumber } from "./util.js"

export async function resolveApiKey(integration, integrationID = "commandcode") {
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY
  try {
    const connection = await integration.connection.active(integrationID)
    if (!connection) return undefined
    return credentialApiKey(await integration.connection.resolve(connection))
  } catch {
    return undefined
  }
}

export function credentialApiKey(value) {
  if (typeof value === "string") return value || undefined
  const credential = asRecord(value)
  if (!credential) return undefined
  if (credential.type === "key") return asString(credential.key)
  return asString(credential.key) ?? asString(credential.apiKey) ?? asString(credential.access)
}

export function normalizePlan(planID) {
  if (typeof planID !== "string") return undefined
  const normalized = planID.toLowerCase().replace(/^individual[-_]/, "").replace(/[_\s]+/g, "-")
  if (normalized === "go") return { id: normalized, tier: "go", rank: 0 }
  if (normalized.includes("goat")) return { id: normalized, tier: "goat", rank: 1 }
  if (normalized.includes("pro")) return { id: normalized, tier: "pro", rank: 2 }
  if (normalized.includes("max")) return { id: normalized, tier: "max", rank: 3 }
  // Provider has the full API catalog; Team/Enterprise plans are custom and
  // should not be artificially filtered by the consumer plugin.
  if (normalized.includes("provider") || normalized.includes("team") || normalized.includes("enterprise")) {
    return { id: normalized, tier: normalized, rank: Number.POSITIVE_INFINITY }
  }
  return { id: normalized, tier: normalized, rank: Number.POSITIVE_INFINITY }
}

export async function fetchSubscription(apiKey, baseURL) {
  const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` }
  const whoami = await fetchJson(`${baseURL}/alpha/whoami`, { headers })
  const orgID = asString(whoami?.org?.id)
  const url = new URL(`${baseURL}/alpha/billing/subscriptions`)
  if (orgID) url.searchParams.set("orgId", orgID)
  const response = await fetchJson(url, { headers })
  const subscription = asRecord(response?.data)
  const plan = normalizePlan(asString(subscription?.planId))
  if (!plan) throw new Error("Command Code returned no subscription plan")
  return { plan, subscription, whoami, orgID }
}

async function accountRequest(baseURL, endpoint, apiKey) {
  return fetchJson(`${baseURL}${endpoint}`, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
  })
}

export async function fetchUsage(apiKey, baseURL) {
  const whoami = await accountRequest(baseURL, "/alpha/whoami", apiKey)
  const org = asRecord(whoami?.org)
  const user = asRecord(whoami?.user)
  const orgID = asString(org?.id)
  const query = orgID ? `?orgId=${encodeURIComponent(orgID)}` : ""
  const [creditsResponse, subscriptionResponse] = await Promise.all([
    accountRequest(baseURL, `/alpha/billing/credits${query}`, apiKey),
    accountRequest(baseURL, `/alpha/billing/subscriptions${query}`, apiKey),
  ])
  const subscription = asRecord(subscriptionResponse?.data)
  const since = asString(subscription?.currentPeriodStart)
  const summaryQuery = new URLSearchParams(orgID ? { orgId: orgID } : {})
  if (since) summaryQuery.set("since", since)
  const summary = await accountRequest(
    baseURL,
    `/alpha/usage/summary${summaryQuery.size ? `?${summaryQuery}` : ""}`,
    apiKey,
  )
  return { whoami, org, user, creditsResponse, subscription, summary, since }
}

function dollars(value) {
  return `$${value.toFixed(2)}`
}

function resetLabel(value) {
  let seconds
  if (typeof value === "number") seconds = value >= 1e12 ? value / 1000 : value
  if (typeof value === "string") {
    const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
    seconds = timestamp >= 1e12 ? timestamp / 1000 : timestamp
  }
  if (!Number.isFinite(seconds)) return ""
  const minutes = Math.ceil((seconds * 1000 - Date.now()) / 60_000)
  if (minutes <= 0) return " (resets soon)"
  if (minutes < 60) return ` (resets in ${minutes}m)`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return ` (resets in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""})`
  const days = Math.floor(hours / 24)
  return ` (resets in ${days} day${days === 1 ? "" : "s"})`
}

function formatTokens(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function periodLabel(value) {
  if (typeof value !== "string" && typeof value !== "number") return ""
  const timestamp = typeof value === "number" || /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  const date = new Date(timestamp >= 1e12 ? timestamp : timestamp * 1000)
  if (Number.isNaN(date.getTime())) return ""
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000)
  const dateText = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  return days > 0 ? ` · renews ${dateText} (${days}d)` : days === 0 ? ` · renews ${dateText} (today)` : ` · renewed ${dateText}`
}

export function formatUsage(data) {
  const { org, user, creditsResponse, subscription, summary, since } = data
  const creditValues = asRecord(creditsResponse?.credits) ?? {}
  const monthly = nonNegativeNumber(creditValues.monthlyCredits) ?? 0
  const purchased = nonNegativeNumber(creditValues.purchasedCredits) ?? 0
  const free = nonNegativeNumber(creditValues.freeCredits) ?? 0
  const remaining = monthly + purchased + free
  const spent = nonNegativeNumber(summary?.totalCost) ?? 0
  const pool = remaining + spent
  const lines = [
    "Command Code usage",
    "",
    "Credits",
    `  Remaining: ${dollars(remaining)} of ${dollars(pool)}`,
    `  Used: ${dollars(spent)} (${pool > 0 ? Math.round((spent / pool) * 100) : 0}%)`,
    `  Sources: monthly ${dollars(monthly)} / purchased ${dollars(purchased)}${free > 0 ? ` / free ${dollars(free)}` : ""}`,
  ]
  if (subscription) {
    const plan = (asString(subscription.planId) ?? "Unknown").replace(/[_-]+/g, " ")
    const status = asString(subscription.status)
    lines.push(`  Plan: ${plan}${status ? ` (${status})` : ""}${periodLabel(subscription.currentPeriodEnd)}`)
  }
  lines.push("", since ? "Usage (billing period)" : "Usage")
  lines.push(`  Cost: ${dollars(spent)}`)
  lines.push(`  Requests: ${(nonNegativeNumber(summary?.totalCount) ?? 0).toLocaleString("en-US")}`)
  const tokens = nonNegativeNumber(summary?.totalTokens) ?? nonNegativeNumber(summary?.tokens)
  if (tokens !== undefined) lines.push(`  Tokens: ${formatTokens(tokens)}`)
  lines.push("", "Account")
  lines.push(`  ${asString(user?.keyName) ?? asString(user?.displayName) ?? asString(org?.login) ?? asString(user?.userName) ?? asString(user?.name) ?? "Unknown"}`)

  const limits = asRecord(creditsResponse?.windowLimits)
  const windows = [
    ["5-hour", asRecord(limits?.fiveHour)],
    ["Weekly", asRecord(limits?.weekly)],
  ].filter(([, value]) => value && nonNegativeNumber(value.used) !== undefined && nonNegativeNumber(value.cap) !== undefined)
  if (windows.length) {
    lines.push("", "Usage windows")
    for (const [label, value] of windows) {
      const used = nonNegativeNumber(value.used) ?? 0
      const cap = nonNegativeNumber(value.cap) ?? 0
      if (used === 0 && cap === 0) continue
      lines.push(`  ${label}: ${used.toFixed(2)} / ${cap.toFixed(2)} credits (${cap > 0 ? Math.round((used / cap) * 100) : 0}%)${resetLabel(value.resetAt)}`)
    }
  }
  lines.push("", "Full detail: https://commandcode.ai/usage")
  return lines.join("\n")
}
