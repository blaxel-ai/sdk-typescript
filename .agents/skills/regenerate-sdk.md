---
name: regenerate-sdk
description: Regenerate the auto-generated SDK client from the OpenAPI specs of the sandbox or controlplane repos. Use when API endpoints change upstream and the TypeScript SDK needs to be updated. Trigger on "regenerate sdk", "update sdk client", "regen sdk", or "/regenerate-sdk".
---

# Regenerate SDK Client

Regenerate the auto-generated TypeScript SDK client (`types.gen.ts`, `sdk.gen.ts`) from the upstream OpenAPI specifications.

## Sources

| Target | Upstream repo | Spec path | SDK output |
|--------|--------------|-----------|------------|
| `sdk-sandbox` | `blaxel-ai/sandbox` | `sandbox-api/docs/openapi.yml` | `@blaxel/core/src/sandbox/client/` |
| `sdk-controlplane` | `blaxel-ai/controlplane` | `api/api/definitions/controlplane.yml` | `@blaxel/core/src/client/` |

## Steps

### 1. Determine which target(s) to regenerate

Ask the user or infer from context:
- **sandbox** -- if the change involves sandbox API endpoints (filesystem, process, drives, codegen, network, upgrade)
- **controlplane** -- if the change involves platform API endpoints (sandbox CRUD, previews, volumes, agents, etc.)
- **both** -- run `make sdk` (default if unclear)

### 2. Determine the source branch

By default, `make sdk-sandbox` and `make sdk-controlplane` pull from `main`. If the user needs to regenerate from a feature branch (e.g. because the upstream spec has not been merged yet):

1. **Temporarily edit the Makefile** to change `?ref=main` to `?ref=<branch-name>` for the relevant target(s).
2. Run the make command.
3. **Revert the Makefile change** immediately after -- it must NOT be included in any commit.

Example for sandbox on branch `cploujoux/fix-drive-types`:
```bash
# Temporarily point to the feature branch
sed -i.bak 's|openapi.yml?ref=main|openapi.yml?ref=cploujoux/fix-drive-types|' Makefile
make sdk-sandbox
# Revert -- do NOT commit the Makefile change
mv Makefile.bak Makefile
```

For controlplane:
```bash
sed -i.bak 's|controlplane.yml?ref=main|controlplane.yml?ref=<branch>|' Makefile
make sdk-controlplane
mv Makefile.bak Makefile
```

### 3. Run the generation

```bash
make sdk            # both sandbox + controlplane
make sdk-sandbox    # sandbox only
make sdk-controlplane  # controlplane only
```

This uses `@hey-api/openapi-ts@0.66.0` to generate from the downloaded OpenAPI spec.

### 4. Verify

After regeneration:
1. Type-check: `cd @blaxel/core && npx tsc --noEmit`
2. If there are new endpoints, update any wrapper code (e.g. `drive.ts`, `session.ts`) to use the generated functions instead of raw HTTP calls.
3. If there are breaking changes (renamed types, removed endpoints), fix all compile errors.
4. Rebuild: `cd @blaxel/core && npm run build`
5. Run relevant integration tests to confirm the SDK works end-to-end.

### 5. Important rules

- **Never commit Makefile branch overrides.** The `?ref=` change is temporary and must be reverted before any commit.
- **Generated files should be committed.** The `*.gen.ts` files in `sandbox/client/` and `client/` are checked into git.
- **Do not manually edit `*.gen.ts` files.** They will be overwritten on next regeneration. If you need to add types or fix naming, do it in the OpenAPI spec upstream or in wrapper files.
- **Wrapper code uses generated functions.** For example, `SandboxDrive.mount()` should call `postDrivesMount()` from `sdk.gen.ts`, not make raw `h2Fetch` or `this.client.post()` calls.
