# Integration tests

Integration tests run against the real Blaxel API.

```bash
cd @blaxel/core && npm run build && cd ../..
BL_WORKSPACE=my-workspace BL_API_KEY=... npx vitest run tests/integration/sandbox/<file>.test.ts --reporter=verbose
```

Values can also be put in a `.env` file at the repo root.

## Required

| Variable       | Description              |
| -------------- | ------------------------ |
| `BL_WORKSPACE` | Workspace to run against |
| `BL_API_KEY`   | API key for that workspace |

## Environment selection

| Variable          | Default                                  | Description |
| ----------------- | ---------------------------------------- | ----------- |
| `BL_ENV`          | `prod`                                   | `dev` switches default regions and the sandbox-api version used by `system.test.ts` |
| `BL_REGION`       | `us-was-1` (prod) / `eu-dub-1` (dev)     | Region for test sandboxes. When set, the `BL_REGION` auto-fill suite in `region.test.ts` is skipped |
| `BL_DRIVE_REGION` | `us-was-1` (prod) / `eu-dub-1` (dev)     | Region for drive tests (`drives.test.ts`, `drive-acl.test.ts`) |
| `SKIP_CLEANUP`    | unset                                    | `1` keeps test resources around after the run, for debugging |
| `LOCAL_PROCESS_API_URL` | unset                              | Points `process-recovery.test.ts` at a local sandbox-api instead of creating a sandbox |

## Feature flags

Opt-in suites, all off by default. Enable with `true` or `1`, e.g.
`RUN_VOLUME_TESTS=true npx vitest run ...`. They are registered in
[`vitest.config.ts`](../../vitest.config.ts) (`test.env`), which is the source of truth.

| Flag                         | Gates | Why it is off by default |
| ---------------------------- | ----- | ------------------------ |
| `RUN_SCHEDULE_TESTS`         | `schedules.test.ts` (whole suite) | Scheduler suite kept out of the default run |
| `RUN_SLOW_SCHEDULES`         | `schedules.test.ts` > "firing" (also needs `RUN_SCHEDULE_TESTS`) | Waits on the scheduler tick, ~45-65s |
| `RUN_SLOW_ARCHIVE`           | `archive.test.ts` | Archive/unarchive takes minutes each way |
| `RUN_SLOW_RESTORE`           | `snapshots.test.ts` > "Sandbox snapshot restore" | Full sandbox rebuild from a snapshot |
| `RUN_SLOW_SNAPSHOT_FORK`     | `workspace-snapshots.test.ts` > fork from a deleted source | Extra full sandbox start |
| `RUN_SLOW_TTL`               | `lifecycle.test.ts` > TTL expiry tests | Minimum TTL is 5m, so each test waits 5-8 minutes |
| `IMAGE_BUILD`                | `image-build.test.ts`, `applications.test.ts` | Builds and deploys a custom image |
| `ENABLE_CUSTOM_DOCKER_TESTS` | `image.test.ts` > "with custom Docker images" | Needs prebuilt custom images in the workspace |
| `RUN_CUSTOM_DOMAIN_TESTS`    | `custom-domains.test.ts` | Creates and deletes real custom domains |
| `RUN_DRIVE_TESTS`            | `drives.test.ts`, `drive-acl.test.ts`, `mount-drives.test.ts` | Needs a drive-enabled region |
| `RUN_VOLUME_TESTS`           | `volumes.test.ts`, volume blocks of `region.test.ts`, volume test of `large-envs.test.ts` | Volumes are not enabled on mk3.1 hosts yet |
| `RUN_FIREWALL_RULESET_TESTS` | `proxy/firewall.test.ts` > "no proxy bypass (firewall ruleset: proxy)" | Firewall rulesets are not enabled on mk3.1 hosts yet |

## Credential gates

These tests are skipped until the secret is provided.

| Variable                                     | Gates |
| -------------------------------------------- | ----- |
| `RELACE_API_KEY`                             | `codegen.test.ts` > "fastapply with Relace" |
| `MORPH_API_KEY`                              | `codegen.test.ts` > "fastapply with Morph" |
| `ANTHROPIC_API_KEY`                          | `proxy/claude.test.ts` |
| `BL_TEST_GCS_BUCKET` + `GCSFUSE_SA_KEY_JSON` | `proxy/connect-tunnel.test.ts` > "gcsfuse with native HTTP/2" |
| `BL_CLIENT_CREDENTIALS`                      | `common/client-credentials-refresh.test.ts` |

## Adding a flag

Register it in `vitest.config.ts` under `test.env`, defaulting to `"false"`, with a
comment saying what it gates and why. Gate the test with
`describe.runIf(isSlowTestEnabled("FLAG"))` (or `it.runIf`) from
`sandbox/helpers.ts`, then add a row to the table above.
