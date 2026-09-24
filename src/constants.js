export const PROVIDER_ID = "commandcode"
export const INTEGRATION_ID = "commandcode"
// Keep the established plugin id so existing OpenCode 2 users do not end up
// with a second logical plugin after moving from the old shell-based release.
export const PLUGIN_ID = "commandcode-provider"
export const PACKAGE_NAME = "opencode-commandcode-provider"

export const DEFAULT_ACCOUNT_API_BASE = "https://api.commandcode.ai"
export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
export const DEFAULT_NPM_REGISTRY_BASE = "https://registry.npmjs.org"

export const DEFAULT_REFRESH_MS = 60 * 60_000
export const DEFAULT_METADATA_REFRESH_MS = 6 * 60 * 60_000
export const DEFAULT_PLAN_REFRESH_MS = 5 * 60_000

export const STORAGE_SETTINGS = "settings/v1"
export const STORAGE_SNAPSHOT = "catalog/snapshot-v1"
export const STORAGE_METADATA = "catalog/metadata-v1"
