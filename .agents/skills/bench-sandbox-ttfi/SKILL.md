---
name: bench-sandbox-ttfi
description: Compare sandbox "time to first interaction" between the current git branch and main in the Blaxel sdk-typescript repo. Runs the cold-call benchmark (create sandbox, first call, delete) on both branches, then reports a side-by-side table. Use when the user says "compare sandbox bench", "compare ttfi", "bench PR vs main", "run sandbox bench compare", "time to first interaction", or provides a PR/branch and asks to benchmark it against main. Builds @blaxel/core before each run. Caps total sandbox usage to stay under 50.
---

# Sandbox Time-to-First-Interaction Comparison

## Purpose

Measure how a code change affects the end-to-end latency of:
`SandboxInstance.create()` → first operation (`fs.ls('/')`, `process.exec`) → `SandboxInstance.delete()`.

This is the "time to first interaction" a user experiences when spinning up a fresh sandbox. Compares the **current git branch** against **main** under identical conditions.

Works specifically in `~/projects/blaxel/sdk/sdk-typescript` (or any sdk-typescript checkout). The benchmark file is `tests/benchmarks/sandbox/cold-call.bench.ts`.

## Pre-flight checks

Run these and abort with a clear message if any fail:

1. Confirm cwd is inside the sdk-typescript repo. Check that `@blaxel/core/package.json` and `tests/benchmarks/sandbox/cold-call.bench.ts` exist.
2. `git status --porcelain` must be empty. If dirty, tell the user to commit/stash first — switching to main would lose uncommitted work.
3. Capture the current branch: `git branch --show-current`. If it equals `main`, ask the user to specify which branch they want to compare (the point of the skill is PR vs main).
4. Confirm env vars / auth:
   - `~/.blaxel/config.yaml` exists, OR
   - `BL_WORKSPACE` and `BL_API_KEY` are set.
   If neither, abort and tell the user to run `bl login` or set the env vars.
5. Budget check: the bench creates ~22 sandboxes per run (10 iterations + 1 warmup for each of the 2 bench cases). Two runs = ~44. Warn the user if they have any active sandbox work that might push the workspace over quota.

## Steps

### 1. Benchmark the current (PR) branch

```bash
cd @blaxel/core && bun run build && cd ..
mkdir -p tmp
BL_WORKSPACE=${BL_WORKSPACE:-main} npx vitest bench --run tests/benchmarks/sandbox/cold-call.bench.ts 2>&1 | tee tmp/bench-pr.log
cp tmp/bench-results.json tmp/bench-pr.json
```

The build must succeed before the bench (the bench imports from `dist/esm`). Use a 5-minute timeout for the build and a 10-minute timeout for the bench.

### 2. Switch to main and benchmark

```bash
git checkout main
cd @blaxel/core && bun run build && cd ..
BL_WORKSPACE=${BL_WORKSPACE:-main} npx vitest bench --run tests/benchmarks/sandbox/cold-call.bench.ts 2>&1 | tee tmp/bench-main.log
cp tmp/bench-results.json tmp/bench-main.json
```

### 3. Restore the original branch and rebuild

```bash
git checkout <original-branch>
cd @blaxel/core && bun run build && cd ..
```

This step is non-negotiable — leave the user's working tree exactly as you found it (same branch, same `dist/` contents).

### 4. Parse results and present the comparison

Extract `min`, `mean`, `p75`, `max`, `rme` from each bench in the two `tmp/bench-*.json` files. Present as a single markdown table with one row per (bench, branch):

```
| Bench | Branch | min | mean | p75 | max | rme |
|---|---|---|---|---|---|---|
| create → fs.ls('/') → delete | PR  | ... | ... | ... | ... | ... |
| create → fs.ls('/') → delete | main | ... | ... | ... | ... | ... |
| create → process.exec → delete | PR  | ... | ... | ... | ... | ... |
| create → process.exec → delete | main | ... | ... | ... | ... | ... |
```

Then add a short verdict section:

- Delta on `mean` for each bench (ms and %).
- Which branch is faster and by how much.
- A note on variance (rme) — a wider rme means the result is less trustworthy.
- A caveat that results include real network latency to the control plane and are not fully deterministic. Two runs within ±10 ms on the mean are essentially equivalent.

### 5. Save comparison artifacts

Leave `tmp/bench-pr.json`, `tmp/bench-main.json`, `tmp/bench-pr.log`, `tmp/bench-main.log` in place for later review. Do not delete them.

## Notes on benchmark interpretation

- The benchmark measures the **full cycle** (create + first-op + delete), not just `create()`. That is intentional — it matches what a user perceives as "time to first interaction".
- `fs.ls('/')` is a lightweight filesystem call; `process.exec('echo ok')` is a slightly heavier path that spawns a process. The two rows give a sense of whether a regression is in the auth/connect phase or in the per-operation path.
- The benchmark uses `blaxel/base-image:latest`. Cold-start time for the underlying VM image dominates the mean, so small SDK-level changes (microsecond-scale code paths) will be invisible here. This bench catches changes that affect:
  - module import / autoload cost
  - auth interceptor latency
  - URL resolution and H2 connection setup
  - anything that adds an extra round trip before the first call
- If you want to isolate SDK-only overhead, re-run several times and look at `min` rather than `mean` — `min` approaches the theoretical fastest path and is less noisy than `mean`.

## Failure modes

- **`bun run build` fails**: do not run the bench on stale `dist/`. Surface the build error and stop.
- **Bench reports 0 samples or the JSON is missing**: vitest likely crashed. Show the log tail from `tmp/bench-*.log`.
- **Sandbox creation fails (quota, auth)**: stop immediately and surface the error. Do not switch branches — the user needs to fix auth first.
- **User interrupts mid-run**: the teardown hook (`tests/benchmarks/sandbox/teardown.ts`) will clean up orphan sandboxes on the next run, so no manual cleanup is required. But do remind the user that the git branch may be left on `main` and they should `git checkout <their-branch>` if so.

## Custom branch comparison

If the user wants to compare two branches other than `current vs main`, accept optional args: `bench-sandbox-ttfi <branch-a> <branch-b>`. Replace `main` in steps 2 and 3 accordingly. Still return to the user's original branch at the end.
