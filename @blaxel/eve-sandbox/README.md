# @blaxel/eve-sandbox

[Blaxel](https://blaxel.ai) sandbox backend for [eve](https://eve.dev).

Run eve's built-in shell and file tools in secure, durable Blaxel sandboxes. Each durable eve session reconnects to the same sandbox after an application restart without relying on preview-only Blaxel APIs.

## Quick start

You need Node.js 24 or later and an existing [eve project](https://eve.dev/docs/installation).

### 1. Install the backend

```bash
npm install @blaxel/eve-sandbox
```

The package expects the `eve` and `ai` versions already installed by your eve project.

### 2. Authenticate with Blaxel

For local development, sign in with the [Blaxel CLI](https://docs.blaxel.ai/cli-reference/overview):

```bash
bl login YOUR-WORKSPACE
```

In CI and production, provide `BL_WORKSPACE` and `BL_API_KEY` to the application runtime. Do not copy those credentials into the sandbox.

### 3. Select Blaxel in eve

```ts
// agent/sandbox.ts
import { blaxel } from "@blaxel/eve-sandbox";
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: blaxel({
    image: "blaxel/ts-app:latest",
    lifecycle: {
      expirationPolicies: [{ type: "ttl-idle", value: "1d", action: "delete" }],
    },
    memory: 4096,
  }),
  async onSession({ use }) {
    const sandbox = await use({
      networkPolicy: { allow: ["github.com", "*.npmjs.org"] },
    });
    await sandbox.run({ command: "mkdir -p /workspace/project" });
  },
});
```

Start eve as usual:

```bash
npm run dev
```

The built-in `bash`, `read_file`, `write_file`, `glob`, and `grep` tools now operate inside the Blaxel sandbox. To smoke-test the setup in eve's terminal UI, ask the agent to create `/workspace/hello.txt` and read it back.

A copy-ready sandbox definition is available in [`examples/agent/sandbox.ts`](./examples/agent/sandbox.ts).

## What works

- All five built-in eve sandbox tools
- Blocking commands and streaming background processes
- Text, binary, and streaming file operations
- Durable filesystem and process state across turns and app restarts
- Custom Blaxel images, regions, resources, volumes, environment variables, and lifecycle policies
- Per-session setup through `onSession()`
- Domain egress policies and secret-backed header transforms
- Deterministic reconnection through eve's captured session metadata

## Generally available capability scope

The backend intentionally uses only generally available Blaxel sandbox APIs. It does not call Blaxel snapshot or fork APIs.

eve's `bootstrap()` hook and files under `agent/sandbox/workspace` require a backend to clone a build-time template. This backend does not implement template prewarming. If either feature is configured, it fails with actionable guidance before serving traffic.

Put reusable system dependencies and base files in a [custom Blaxel image](https://docs.blaxel.ai/Sandboxes/Templates). Put setup that must run once for each durable eve session in `onSession()`.

## Lifecycle

- `create()` reconnects a saved sandbox by name or creates a new sandbox from the configured image.
- `onSession()` performs one-time setup for a new durable eve session.
- Session names include the backend configuration identity, so a changed sandbox definition gets a new sandbox.
- `captureState()` persists the Blaxel sandbox name in eve's durable session state.
- `shutdown()` closes active log streams. Blaxel then moves the idle sandbox into standby while preserving memory, processes, and files.

Session discovery uses Blaxel resources and does not depend on an in-process registry.

## Network policy

The backend supports:

- `"allow-all"`
- `"deny-all"`
- Domain allow-lists
- eve header transforms through Blaxel's secret-backed egress proxy

The backend rejects subnet rules, request match conditions, and `forwardURL`. It does not silently weaken unsupported policies.

The default is `"allow-all"`. For production or untrusted workloads, select `"deny-all"` or an explicit allow-list before the first command runs.

## Options

`blaxel()` accepts standard `SandboxCreateConfiguration` fields such as `image`, `memory`, `region`, `ports`, `envs`, `volumes`, `ttl`, `lifecycle`, and `labels`.

| Option | Purpose | Default |
| --- | --- | --- |
| `backendName` | Stable eve backend identifier | `blaxel` |
| `namePrefix` | Prefix for deterministic Blaxel resources | `eve` |
| `networkPolicy` | Egress policy applied when a session sandbox is created | `"allow-all"` |
| `processOutputBufferBytes` | Maximum unread stdout or stderr per process stream | 1 MiB |
| `startupTimeoutMs` | Maximum cold-image readiness wait | 60 seconds |

## Compatibility

| Package | eve | AI SDK | Node.js | Default image |
| --- | --- | --- | --- | --- |
| `@blaxel/eve-sandbox` 0.2.x | 0.31.3 to less than 0.32 | 7.0.38 to less than 8 | 24 or later | `blaxel/ts-app:latest` |

Each release must pass the adapter contract suite and a live eve agent evaluation against its declared range. A new eve minor requires a tested peer-range update.

## Cleanup

Blaxel sandboxes remain durable until their configured lifecycle removes them. Set `lifecycle` or `ttl` when the application requires automatic deletion of inactive sessions.
