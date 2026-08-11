---
name: manual-script
description: Conventions for writing a script in tests/manual/ in the Blaxel sdk-typescript repo (autoload credentials, env-var knobs, cleanup, H2 workaround). Trigger on "add a manual script", "write a reproducer", "repro script", "tests/manual", or "/manual-script".
---

# Write a `tests/manual/` script

`tests/manual/` holds scripts that are run by hand — reproducers, load/churn
tests, one-off migrations — because they are too slow or too expensive for CI
(see `tests/manual/README.MD`). They are plain `tsx` entrypoints, not vitest
tests.

## Never require BL_WORKSPACE / BL_API_KEY

`@blaxel/core` authenticates itself on import: `src/index.ts` imports
`common/autoload.js`, which resolves credentials lazily from `bl login`'s local
config (`~/.blaxel/config.yaml`) or the environment, and refreshes tokens per
request. So a manual script must just call the SDK.

Do NOT write credential preflight checks like:

```typescript
// ✗ breaks `bl login` users, who have no BL_API_KEY in the environment
if (!settings.workspace) throw new Error("BL_WORKSPACE must be set")
if (!process.env.BL_API_KEY) throw new Error("BL_API_KEY must be set")
```

Instead, document it in the header comment and let autoload do its job:

```typescript
// Credentials are picked up automatically via @blaxel/core autoload (local
// `bl login` config / env), so BL_WORKSPACE / BL_API_KEY are not required here.

import { SandboxInstance, VolumeInstance } from "@blaxel/core"
```

Reference: `tests/manual/ephemeral_volume.ts`,
`tests/manual/volume_delete_during_create.ts`.

Only call `initialize({ workspace, apiKey })` when the script deliberately
targets credentials other than the local ones. `BL_ENV=dev` still selects
`api.blaxel.dev` — mention it in the header when it matters.

Note that `tests/integration/` is different: vitest loads `.env` and those tests
DO require `BL_WORKSPACE` / `BL_API_KEY`.

## The rest of the shape

1. **Header comment first**: what it reproduces / does, the expected outcome,
   the run command, and a list of every env-var knob with its default.
2. **H2 workaround before the import** — required, `process.env` must be set
   before `@blaxel/core` is loaded:
   ```typescript
   // Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
   process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"
   ```
3. **Parameterize with env vars**, each with a default, so no edit is needed to
   re-run with different sizes/regions/iterations.
4. **Unique resource names** (`uuidv4().replace(/-/g, "").substring(0, 8)`) and
   `labels = { env: "manual-test", "created-by": "<script>" }` so leftovers are
   identifiable and sweepable.
5. **Clean up** sandboxes and volumes at the end, with a `KEEP=1` escape hatch
   for inspecting a reproduction.
6. **Timestamped logs** relative to the script start, and a final summary block
   with the numbers the script exists to measure.
7. `console.log` is fine here (the no-console rule is for library code).

## Before handing it over

```bash
cd @blaxel/core && npm run build   # scripts import the compiled dist/
npx tsc --noEmit -p tests/tsconfig.json
npx eslint tests/manual/<script>.ts
npx tsx tests/manual/<script>.ts   # actually run it once
```

`eslint` reports every SDK call as `no-unsafe-*` when `@blaxel/core/dist` is
missing — build first, then trust the result.
