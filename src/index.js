import {
  DEFAULT_ACCOUNT_API_BASE,
  DEFAULT_METADATA_REFRESH_MS,
  DEFAULT_MODELS_URL,
  DEFAULT_NPM_REGISTRY_BASE,
  DEFAULT_PLAN_REFRESH_MS,
  DEFAULT_REFRESH_MS,
  INTEGRATION_ID,
  PACKAGE_NAME,
  PLUGIN_ID,
  PROVIDER_ID,
  STORAGE_METADATA,
  STORAGE_SETTINGS,
  STORAGE_SNAPSHOT,
} from "./constants.js"
import {
  buildMetadata,
  deserializeMetadata,
  fetchLiveModels,
  fetchOfficialPackage,
  filterLiveModels,
  serializeMetadata,
  toOpenCodeModels,
} from "./catalog.js"
import { fetchSubscription, fetchUsage, formatUsage, resolveApiKey } from "./account.js"
import { createCommandCode } from "./runtime.js"
import { clampInteger, errorMessage, formatTimestamp, normalizePromptArgument } from "./util.js"

function modelMode(value) {
  if (value === "full") return "full"
  return "subscription"
}

function eventPayload(event) {
  if (event?.data && typeof event.data === "object") return event.data
  if (event?.properties && typeof event.properties === "object") return event.properties
  return event
}

function connectionMatches(event) {
  const payload = eventPayload(event)
  const integrationID = payload?.integrationID ?? payload?.integration?.id
  return !integrationID || integrationID === INTEGRATION_ID || integrationID === PROVIDER_ID
}

async function showSynthetic(ctx, sessionID, text, delivery = "steer") {
  await ctx.session.synthetic({
    sessionID,
    text,
    description: text,
    delivery,
    resume: false,
  })
}

function registerIntegration(editor) {
  editor.update(INTEGRATION_ID, (integration) => {
    integration.id = INTEGRATION_ID
    integration.name = "Command Code"
  })
  editor.method.update({
    integrationID: INTEGRATION_ID,
    method: { type: "key", label: "Command Code API key" },
  })
  editor.method.update({
    integrationID: INTEGRATION_ID,
    method: { type: "env", names: ["COMMANDCODE_API_KEY"] },
  })
}

function subscribeCredentialEvents(ctx, onChange) {
  try {
    const stream = ctx.event?.subscribe?.()
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return undefined
    let stopped = false
    void (async () => {
      for await (const event of stream) {
        if (stopped) break
        const type = typeof event?.type === "string" ? event.type : ""
        if (!type.startsWith("credential.")) continue
        if (!connectionMatches(event)) continue
        onChange()
      }
    })().catch(() => {})
    return () => { stopped = true }
  } catch {
    return undefined
  }
}

export const plugin = {
  id: PLUGIN_ID,

  async setup(ctx) {
    const registrations = []
    const track = async (promise) => {
      const registration = await promise
      if (registration?.dispose) registrations.push(registration)
      return registration
    }

    const options = ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    const accountBase = String(options.accountBaseURL ?? process.env.COMMANDCODE_ACCOUNT_API_BASE ?? DEFAULT_ACCOUNT_API_BASE).replace(/\/+$/, "")
    const modelsURL = String(options.modelsURL ?? process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL)
    const registryBase = String(options.npmRegistryBaseURL ?? process.env.COMMANDCODE_NPM_REGISTRY_BASE ?? DEFAULT_NPM_REGISTRY_BASE).replace(/\/+$/, "")
    const refreshMs = clampInteger(options.refreshIntervalMs, DEFAULT_REFRESH_MS, 15_000, 60 * 60_000)
    const metadataRefreshMs = clampInteger(options.metadataRefreshIntervalMs, DEFAULT_METADATA_REFRESH_MS, 60_000, 24 * 60 * 60_000)
    const planRefreshMs = clampInteger(options.planRefreshIntervalMs, DEFAULT_PLAN_REFRESH_MS, 30_000, 24 * 60 * 60_000)

    const storedSettings = await ctx.storage.get(STORAGE_SETTINGS).catch(() => undefined)
    let mode = modelMode(options.modelMode ?? storedSettings?.modelMode)
    const storedMetadata = await ctx.storage.get(STORAGE_METADATA).catch(() => undefined)
    let metadata = deserializeMetadata(storedMetadata)
    let metadataFetchedAt = Number(storedMetadata?.fetchedAt ?? 0)
    // Older cache entries may not have a timestamp on the metadata itself.
    if (!Number.isFinite(metadataFetchedAt)) metadataFetchedAt = 0

    const cachedSnapshot = await ctx.storage.get(STORAGE_SNAPSHOT).catch(() => undefined)
    let liveModels = Array.isArray(cachedSnapshot?.liveModels) ? cachedSnapshot.liveModels : []
    let publishedModels = []
    let sourceConnection
    let lastRefreshAt = Number(cachedSnapshot?.fetchedAt ?? 0) || 0
    let lastRefreshError
    let currentPlan
    let planFetchedAt = 0
    let commandCodeVersion = metadata?.version
    let refreshInflight

    await track(ctx.integration.transform(registerIntegration))

    const refreshConnection = async () => {
      try {
        sourceConnection = await ctx.integration.connection.active(INTEGRATION_ID)
      } catch {
        sourceConnection = undefined
      }
    }

    const deriveModels = () => {
      const filtered = filterLiveModels(liveModels, metadata, currentPlan, mode)
      return toOpenCodeModels(filtered, metadata)
    }

    await track(ctx.provider.transform((editor) => {
      if (!publishedModels.length) return
      if (typeof editor.remove === "function") editor.remove(PROVIDER_ID)
      editor.add({
        info: {
          id: PROVIDER_ID,
          integrationID: INTEGRATION_ID,
          name: "Command Code",
          activation: "enabled",
          package: `aisdk:${PACKAGE_NAME}`,
        },
        models: publishedModels,
        ...(sourceConnection ? { sourceConnection } : {}),
      })
    }))

    const publish = async (nextModels) => {
      const previous = publishedModels
      const previousConnection = sourceConnection
      publishedModels = nextModels
      await refreshConnection()
      try {
        await ctx.provider.reload()
        return true
      } catch (error) {
        publishedModels = previous
        sourceConnection = previousConnection
        lastRefreshError = errorMessage(error)
        return false
      }
    }

    if (liveModels.length) {
      publishedModels = deriveModels()
      await refreshConnection()
      await ctx.provider.reload().catch(() => {})
    }

    async function ensureMetadata(force = false) {
      const now = Date.now()
      if (!force && metadata && now - metadataFetchedAt < metadataRefreshMs) return metadata
      try {
        const packageData = await fetchOfficialPackage(registryBase)
        const next = buildMetadata(packageData, liveModels)
        metadata = next
        metadataFetchedAt = now
        commandCodeVersion = next.version
        await ctx.storage.set(STORAGE_METADATA, {
          ...serializeMetadata(next),
          fetchedAt: now,
        }).catch(() => {})
      } catch (error) {
        if (!metadata) lastRefreshError = `metadata: ${errorMessage(error)}`
      }
      return metadata
    }

    async function ensurePlan(apiKey, force = false) {
      if (mode !== "subscription" || !apiKey) {
        currentPlan = undefined
        planFetchedAt = 0
        return undefined
      }
      const now = Date.now()
      if (!force && currentPlan && now - planFetchedAt < planRefreshMs) return currentPlan
      try {
        const result = await fetchSubscription(apiKey, accountBase)
        currentPlan = result.plan
        planFetchedAt = now
      } catch (error) {
        currentPlan = undefined
        planFetchedAt = 0
        lastRefreshError = `subscription: ${errorMessage(error)}`
      }
      return currentPlan
    }

    async function refresh({ forceMetadata = false, forcePlan = false } = {}) {
      if (refreshInflight) return refreshInflight
      refreshInflight = (async () => {
        lastRefreshError = undefined
        const apiKey = await resolveApiKey(ctx.integration, INTEGRATION_ID)
        let nextLive
        try {
          nextLive = await fetchLiveModels(modelsURL)
        } catch (error) {
          lastRefreshError = `models: ${errorMessage(error)}`
          if (!liveModels.length) throw error
          nextLive = liveModels
        }
        liveModels = nextLive

        await Promise.all([
          ensureMetadata(forceMetadata),
          ensurePlan(apiKey, forcePlan),
        ])

        const nextModels = deriveModels()
        if (!nextModels.length && publishedModels.length) return false
        if (!await publish(nextModels)) return false
        lastRefreshAt = Date.now()
        await ctx.storage.set(STORAGE_SNAPSHOT, {
          fetchedAt: lastRefreshAt,
          liveModels,
        }).catch(() => {})
        return true
      })().finally(() => {
        refreshInflight = undefined
      })
      return refreshInflight
    }

    // Resolve the latest credential and current Command Code package version at
    // request time. The SDK hook can be cached by OpenCode for a long-lived
    // daemon, so static credentials here would go stale after /connect changes.
    if (ctx.aisdk?.hook) {
      await track(ctx.aisdk.hook("sdk", async (event) => {
        if (event.sdk) return
        if (event?.model?.providerID !== PROVIDER_ID) return
        event.sdk = createCommandCode({
          ...(event.options && typeof event.options === "object" ? event.options : {}),
          apiKey: () => resolveApiKey(ctx.integration, INTEGRATION_ID),
          baseURL: event?.options?.baseURL ?? accountBase,
          commandCodeVersion: () => commandCodeVersion,
        })
      }))
      await track(ctx.aisdk.hook("language", (event) => {
        if (event.language) return
        if (event?.model?.providerID !== PROVIDER_ID) return
        if (typeof event?.sdk?.languageModel !== "function") {
          throw new Error("Command Code AI SDK provider has no languageModel()")
        }
        event.language = event.sdk.languageModel(event.model.modelID || event.model.id)
      }))
    }

    const modelStatus = () => {
      const plan = mode === "subscription" ? (currentPlan?.tier ?? "not resolved") : "not used"
      const lines = [
        "Command Code models",
        "",
        `Mode: ${mode}`,
        `Subscription plan: ${plan}`,
        `Published models: ${publishedModels.length}`,
        `Live catalog models: ${liveModels.length}`,
        `Command Code metadata: ${commandCodeVersion ? `command-code@${commandCodeVersion}` : "fallback/live fields only"}`,
        `Last live refresh: ${formatTimestamp(lastRefreshAt)}`,
        `Automatic refresh: every ${Math.round(refreshMs / 1000)}s`,
      ]
      if (lastRefreshError) lines.push(`Last refresh warning: ${lastRefreshError}`)
      lines.push("", "Use: /commandcode-models subscription | full | refresh")
      return lines.join("\n")
    }

    await track(ctx.command.transform((editor) => {
      editor.add({
        name: "commandcode-usage",
        description: "Show Command Code credits, plan, and usage",
        execute: async ({ sessionID, delivery }) => {
          try {
            const apiKey = await resolveApiKey(ctx.integration, INTEGRATION_ID)
            if (!apiKey) throw new Error("No API key found. Use /connect → Command Code or set COMMANDCODE_API_KEY.")
            const usage = await fetchUsage(apiKey, accountBase)
            await showSynthetic(ctx, sessionID, formatUsage(usage), delivery)
          } catch (error) {
            await showSynthetic(ctx, sessionID, `Command Code usage error\n\n${errorMessage(error)}`, delivery)
          }
        },
      })
      editor.add({
        name: "commandcode-models",
        description: "Show, refresh, or switch the Command Code model catalog mode",
        execute: async ({ sessionID, prompt, delivery }) => {
          const argument = normalizePromptArgument(prompt)
          try {
            if (!argument || argument === "status") {
              await showSynthetic(ctx, sessionID, modelStatus(), delivery)
              return
            }
            if (argument === "subscription" || argument === "sub") {
              mode = "subscription"
              currentPlan = undefined
              planFetchedAt = 0
              await ctx.storage.set(STORAGE_SETTINGS, { modelMode: mode })
              await refresh({ forcePlan: true })
              await showSynthetic(ctx, sessionID, `${modelStatus()}\n\nModel mode changed to subscription.`, delivery)
              return
            }
            if (argument === "full" || argument === "all") {
              mode = "full"
              currentPlan = undefined
              planFetchedAt = 0
              await ctx.storage.set(STORAGE_SETTINGS, { modelMode: mode })
              await refresh()
              await showSynthetic(ctx, sessionID, `${modelStatus()}\n\nModel mode changed to full.`, delivery)
              return
            }
            if (argument === "refresh") {
              await refresh({ forceMetadata: true, forcePlan: true })
              await showSynthetic(ctx, sessionID, `${modelStatus()}\n\nLive catalog refreshed.`, delivery)
              return
            }
            await showSynthetic(
              ctx,
              sessionID,
              "Command Code models\n\nUsage: /commandcode-models [subscription|full|refresh|status]",
              delivery,
            )
          } catch (error) {
            await showSynthetic(ctx, sessionID, `Command Code model refresh error\n\n${errorMessage(error)}\n\n${modelStatus()}`, delivery)
          }
        },
      })
    }))

    // Initial refresh is awaited so the first native /models view after plugin
    // startup is sourced from the current live Command Code catalog.
    await refresh({ forceMetadata: !metadata }).catch((error) => {
      lastRefreshError = errorMessage(error)
    })

    const timer = setInterval(() => {
      void refresh().catch((error) => { lastRefreshError = errorMessage(error) })
    }, refreshMs)
    timer.unref?.()

    const unsubscribe = subscribeCredentialEvents(ctx, () => {
      currentPlan = undefined
      planFetchedAt = 0
      void refresh({ forcePlan: true }).catch((error) => { lastRefreshError = errorMessage(error) })
    })

    return async () => {
      clearInterval(timer)
      unsubscribe?.()
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }
    }
  },
}

export { createCommandCode } from "./runtime.js"
export default plugin
