# Provider plugins

Install optional providers with `agent-device plugins`. npm must be available on the host:

```bash
agent-device plugins add @example/agent-device-provider
agent-device plugins list --json
agent-device plugins update @example/agent-device-provider
agent-device plugins remove @example/agent-device-provider
```

Use a full npm package name. To constrain upgrades, add `@version` or `@tag` to the package name.
`update` keeps that constraint; run `add` again to change or remove it.

Plugins are installed under `AGENT_DEVICE_HOME`, which defaults to `~/.agent-device`. Each
installation has its own npm project and lockfile. The CLI records its selection in that home's
`config.json`, preserving other settings. This home is independent of `--state-dir` and
`AGENT_DEVICE_STATE_DIR`. Project config and `--config` do not select executable plugins.

Installs disable npm lifecycle scripts; plugins must publish ready-to-run JavaScript and assets.
Use trusted packages: their factory runs with the daemon's host permissions and environment.

An update validates the new package before selecting it. Failed installs leave the previous
selection intact. Existing daemons keep their original plugin set and files. Close active
sessions, then run `agent-device daemon stop` with the appropriate `--state-dir`; the next device
command starts a daemon with the new set. Removed installations remain on disk for existing
daemons.
Use separate daemon state directories when running different plugin homes; reusing a daemon also
reuses its original home and plugin set.

Compatibility checks read local metadata without contacting npm. Compatible plugins work offline.
An incompatible plugin refuses daemon startup; `plugins list --json` reports its error. Update
or remove that plugin to recover. This first release requires explicit updates and does not
automatically download replacements after a core upgrade.

## Creating a plugin

The provider interface is experimental. Publish a package with this manifest declaration:

```json
{
  "name": "@example/agent-device-provider",
  "version": "1.0.0",
  "type": "module",
  "agentDevicePlugin": {
    "apiVersion": 1,
    "provider": "example",
    "entry": "./dist/plugin.js"
  }
}
```

Import the factory type from `agent-device/plugins` as a development dependency:

```typescript
import type { ProviderPlugin } from 'agent-device/plugins';
import { createRuntime } from './runtime.js';

const plugin: ProviderPlugin = (host) => createRuntime(host);
export default plugin;
```

The factory receives environment variables, package-specific options, and `createError` for
errors recognized by the host. Set options by editing `plugins["<package>"].options` in user
config; leave the managed `installation` field unchanged. Return `{ runtime, platformModule }`. Both must declare the
manifest's provider ID. Runtime construction must not allocate devices; leave platform mechanics
lazy through `platformModule.loadRuntime`. If a factory fails after acquiring resources, it owns
their cleanup. Core cleans up previously returned runtimes when another plugin fails to start.
Keep module initialization and factories prompt and free of network I/O; a stalled factory blocks
daemon startup. Put remote work in request-bound runtime operations instead.

Incompatible runtime contract changes require a new API version. Plugins cannot replace bundled
providers or register arbitrary commands.

Provider loading is available now. Provider-specific `connect` adapters and host services are
being developed with the first integrations. Installing a package alone does not add a new
`connect <provider>` command. Limrun, BrowserStack, and AWS Device Farm remain bundled.
