# Provider plugins

Install optional providers with npm available on your host:

```bash
agent-device plugins add @example/agent-device-provider
agent-device plugins list --json
agent-device plugins update @example/agent-device-provider
agent-device plugins remove @example/agent-device-provider
```

Use a full npm package name, optionally with `@version` or `@tag`. `update` preserves valid constraints and options, including when repairing a damaged selection. Run `add` again to change the constraint.

Each installation has an npm project and lockfile under `AGENT_DEVICE_HOME` (default `~/.agent-device`), selected in its `config.json`. Other settings are preserved. Project config and `--config` cannot select plugins. This home is independent of `--state-dir` and `AGENT_DEVICE_STATE_DIR`.

Installs disable lifecycle scripts: packages must contain ready-to-run JavaScript and assets. Use trusted packages; factories receive the daemon's host permissions and environment.

Failed installs keep the previous selection. Existing daemons retain their plugin set and files, including removed installations. Close sessions and run `agent-device daemon stop` with the appropriate `--state-dir`; the next device command uses the new set. Use separate state directories for different plugin homes.

Compatibility checks run offline using local metadata; provider operations may require network access. An incompatible plugin refuses daemon startup. Run `plugins list --json` to inspect errors, then update or remove the affected package. Core upgrades do not download replacements automatically.

## Creating a plugin

The interface is experimental. Publish this declaration in your package manifest:

```json
{
  "agentDevicePlugin": {
    "apiVersion": 1,
    "provider": "example",
    "entry": "./dist/plugin.mjs"
  }
}
```

Use `agent-device` as a development dependency. The entry exports a default factory typed as `ProviderPlugin` from `agent-device/plugins`. It receives `env`, package-specific `options`, and `createError` for host-recognized errors, and returns `{ runtime, platformModule }` declaring the manifest's provider ID. Set options through `plugins["<package>"].options` in user config; leave `installation` unchanged.

Keep initialization prompt and free of network I/O or device allocation; a stalled factory blocks startup. Load platform mechanics through `platformModule.loadRuntime` and perform remote work in request-bound operations. A failing factory cleans up its own resources; core shuts down previously returned runtimes if another plugin fails.

Incompatible contract changes require a new API version. Plugins cannot replace bundled providers or register arbitrary commands. Installing a package does not add `connect <provider>`; provider-specific connect adapters need separate support. Limrun, BrowserStack, and AWS Device Farm remain bundled.
