# opencode-commandcode-provider

Command Code provider for **OpenCode 2 only**.

It uses OpenCode's native provider, integration, command, storage, and AI SDK hooks.

## What it does

- Adds **Command Code** to `/connect` and `/models`.
- Uses your Command Code subscription-backed generation path.
- Loads the live model list directly from Command Code when OpenCode starts and refreshes it automatically while OpenCode is running.
- Defaults to **subscription** model mode, which filters the live catalog to the active plan when plan metadata is available. Can switch to **full** mode to show the complete live catalog.
- Adds native OpenCode commands for Command Code usage and catalog control.
- Keeps the last successful model list in OpenCode plugin storage as an offline fallback.

## Install

Install it with OpenCode 2:

```bash
opencode plugin add github:grgoruzicanin/opencode-commandcode-provider
```

OpenCode adds the Git package to your global `plugins` configuration.

For local development, point `plugins` at the repository directory instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-commandcode-provider"]
}
```

## Update

For the Git plugin installed above, first check whether an update is available:

```bash
opencode plugin check github:grgoruzicanin/opencode-commandcode-provider
```

Then update it:

```bash
opencode plugin update github:grgoruzicanin/opencode-commandcode-provider
```

To update every outdated package plugin, run `opencode plugin update` without an argument. Restart OpenCode if it is already running so the updated provider is loaded.

If you use the local-development configuration, update the repository instead (for example, `git pull`) and restart OpenCode.

## Connect

In OpenCode, run:

```text
/connect
```

Choose **Command Code** and enter your API key.

You can also use an environment variable:

```bash
export COMMANDCODE_API_KEY="..."
```

Then use the normal OpenCode model picker:

```text
/models
```

## Commands

```text
/commandcode-usage
```

Shows Command Code credits, plan, billing-period usage, request/token totals, and active usage windows inside OpenCode.

```text
/commandcode-models
/commandcode-models subscription
/commandcode-models full
/commandcode-models refresh
```

`subscription` is the default and is persisted in OpenCode plugin storage. `full` only changes what the picker shows; Command Code still enforces the actual account/model entitlement when a request is made. `refresh` immediately refreshes the live model list, plan, and model metadata, although normal use should not require it.

## Optional configuration

The defaults are intended for normal use. If needed, use the object form in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:grgoruzicanin/opencode-commandcode-provider",
      "options": {
        "modelMode": "subscription",
        "refreshIntervalMs": 3600000
      }
    }
  ]
}
```

Supported options:

- `modelMode`: `"subscription"` or `"full"`.
- `refreshIntervalMs`: live model refresh interval. Default: 1 hour; minimum: 15 seconds.
- `metadataRefreshIntervalMs`: refresh interval for Command Code package metadata used for pricing, reasoning variants, limits, and plan filtering. Default: 6 hours. The live model list refreshes every hour by default.
- `planRefreshIntervalMs`: refresh interval for subscription-plan lookup. Default: 5 minutes.
- `accountBaseURL`, `modelsURL`, `npmRegistryBaseURL`: advanced endpoint overrides for development/testing.

`CMD_ZDR=1` is passed through to Command Code requests as before.

## How model discovery works

The live model IDs, names, context lengths, and endpoint availability come from Command Code's runtime model endpoint. Extra metadata such as plan floor, price, reasoning variants, and output limits is refreshed separately from the current `command-code` npm package and cached through OpenCode's plugin storage.

A newly added live model is not hidden just because the enrichment metadata has not caught up yet. It appears in `/models` immediately with conservative fallback metadata, and Command Code remains the final entitlement check. Live fields such as output limits and input modalities are preferred when Command Code provides them.

## Notes

- This package intentionally targets **OpenCode 2 only**. There is no V1 compatibility layer.
- The provider does not write or rewrite `opencode.json(c)` itself.
- Updates are handled by Git/OpenCode's package plugin workflow; there is no custom self-updater.

## Development

```bash
npm test
npm run check
```

The runtime has no production npm dependencies and does not invoke external executables.

## License

This project is licensed under the [MIT License](LICENSE).
