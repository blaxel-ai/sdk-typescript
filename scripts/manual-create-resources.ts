#!/usr/bin/env -S npx tsx
/* eslint-disable no-console */
/**
 * manual-create-resources.ts
 * =========================================================================
 * Bulk-create Blaxel sandboxes and/or volumes for load testing,
 * reproducing customer issues at scale, or seeding a workspace.
 *
 * Every resource created here carries the label:
 *
 *     created-by=manual-create-resources
 *
 * so they are visible as "seeded by this script" in the dashboard / API.
 * To delete them again, use `manual-delete-sandboxes.ts` and
 * `manual-delete-volumes.ts` (both delete EVERYTHING in the workspace
 * after a dry-run review).
 *
 * Authentication
 * --------------
 * Uses the standard `@blaxel/core` credential chain (BL_API_KEY +
 * BL_WORKSPACE env vars, or `~/.blaxel/config.yaml` from `bl login`).
 *
 * Workspace targeting
 * -------------------
 * The first positional argument MUST be the workspace name. The script
 * refuses to run if the resolved active workspace does not match. To
 * switch, run:
 *
 *     bl workspaces <workspace>     (alias: bl ws <workspace>)
 *
 * or set `BL_WORKSPACE=<workspace>` in the environment.
 *
 * Usage
 * -----
 *     npx tsx scripts/manual-create-resources.ts <workspace> <count> [flags]
 *     bun run scripts/manual-create-resources.ts <workspace> <count> [flags]
 *
 * Flags
 * -----
 *   --kind <kind>        What to create: `sandboxes`, `volumes`, or
 *                        `both`. Default: sandboxes.
 *                        With `both`, <count> sandboxes AND <count>
 *                        volumes are created (so 2*count total).
 *   --prefix <p>         Name prefix. Default: `seed-`.
 *                        Resources are named <prefix><random8>.
 *   --region <r>         Region to pin the resources to (e.g. us-was-1).
 *                        Defaults to BL_REGION or the SDK default.
 *   --image <i>          Sandbox image. Default: blaxel/base-image:latest
 *   --memory <mb>        Sandbox memory in MB. Default: 4096.
 *   --size <mb>          Volume size in MB. Default: 1024 (1GB).
 *   --concurrency <n>    Parallel in-flight create calls. Default: 4.
 *                        Keep modest to avoid tripping the WAF.
 *   --delay-ms <n>       Delay between launching each create call.
 *                        Default: 200ms. With concurrency=4 this caps
 *                        throughput at ~20 creates/sec.
 *   --jitter-ms <n>      Random extra delay 0..jitter. Default: 100ms.
 *   --yes                Skip the interactive y/N prompt.
 *
 * Example
 * -------
 *   # Create 500 sandboxes + 500 volumes in `my-ws`:
 *   npx tsx scripts/manual-create-resources.ts my-ws 500 \
 *     --kind both --concurrency 4 --delay-ms 200
 * =========================================================================
 */

import { SandboxInstance, VolumeInstance, settings } from "@blaxel/core";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";

// ---------------------------------------------------------------------------
// Argv parsing.
// ---------------------------------------------------------------------------

type Kind = "sandboxes" | "volumes" | "both";

type Args = {
  workspace: string;
  count: number;
  kind: Kind;
  prefix: string;
  region: string | null;
  image: string;
  memory: number;
  size: number;
  concurrency: number;
  delayMs: number;
  jitterMs: number;
  yes: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Args = {
    workspace: "",
    count: 0,
    kind: "sandboxes",
    prefix: "seed-",
    region: null,
    image: "blaxel/base-image:latest",
    memory: 4096,
    size: 1024,
    concurrency: 4,
    delayMs: 200,
    jitterMs: 100,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--kind": {
        const v = next();
        if (v !== "sandboxes" && v !== "volumes" && v !== "both") {
          throw new Error(`--kind must be one of: sandboxes, volumes, both`);
        }
        args.kind = v;
        break;
      }
      case "--prefix":
        args.prefix = next();
        break;
      case "--region":
        args.region = next();
        break;
      case "--image":
        args.image = next();
        break;
      case "--memory":
        args.memory = Number(next());
        break;
      case "--size":
        args.size = Number(next());
        break;
      case "--concurrency":
        args.concurrency = Number(next());
        break;
      case "--delay-ms":
        args.delayMs = Number(next());
        break;
      case "--jitter-ms":
        args.jitterMs = Number(next());
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "-h":
      case "--help":
        printHelpAndExit(0);
        break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
        positional.push(a);
    }
  }

  if (positional.length !== 2) {
    printHelpAndExit(1, "Exactly two positional arguments are required: <workspace> <count>");
  }
  args.workspace = positional[0];
  args.count = Number(positional[1]);
  if (!Number.isInteger(args.count) || args.count <= 0) {
    printHelpAndExit(1, "<count> must be a positive integer");
  }
  if (args.concurrency < 1) {
    printHelpAndExit(1, "--concurrency must be >= 1");
  }
  return args;
}

function printHelpAndExit(code: number, msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error("Usage: manual-create-resources.ts <workspace> <count> [flags]");
  console.error("Run with --help to see the full doc-comment at the top of the file.");
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Workspace guard.
// ---------------------------------------------------------------------------

function assertWorkspaceMatches(target: string): void {
  const active = settings.workspace;
  if (!active) {
    console.error(
      "No active Blaxel workspace detected.\n" +
        `Run \`bl login\` and \`bl workspaces ${target}\`, or set BL_WORKSPACE and BL_API_KEY in the environment.`
    );
    process.exit(2);
  }
  if (active !== target) {
    console.error(
      `Workspace mismatch.\n` +
        `  Active workspace: ${active}\n` +
        `  Requested:        ${target}\n\n` +
        `Switch with one of:\n` +
        `  bl workspaces ${target}        (alias: bl ws ${target})\n` +
        `  BL_WORKSPACE=${target} <re-run this command>`
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Run async tasks with bounded concurrency and a base delay (+jitter)
 * between *launches*. Tasks return their own result objects; this helper
 * never throws -- callers check the per-task outcome.
 */
async function runThrottled<T>(
  tasks: Array<() => Promise<T>>,
  opts: { concurrency: number; delayMs: number; jitterMs: number }
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      // Stagger launches so all workers do not fire at the same instant.
      await sleep(opts.delayMs + Math.floor(Math.random() * opts.jitterMs));
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, tasks.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Create tasks.
// ---------------------------------------------------------------------------

type CreateResult =
  | { ok: true; name: string; kind: "sandbox" | "volume" }
  | { ok: false; name: string; kind: "sandbox" | "volume"; error: string };

const RESOURCE_LABELS: Record<string, string> = {
  "created-by": "manual-create-resources",
};

function buildSandboxTasks(args: Args): Array<() => Promise<CreateResult>> {
  return Array.from({ length: args.count }, (_, i) => {
    const name = `${args.prefix}${shortId()}`;
    const idx = i + 1;
    return async () => {
      console.log(`[sandbox ${idx}/${args.count}] -> CREATE ${name}`);
      try {
        await SandboxInstance.create({
          name,
          image: args.image,
          memory: args.memory,
          region: args.region ?? undefined,
          labels: { ...RESOURCE_LABELS },
        });
        return { ok: true, name, kind: "sandbox" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[sandbox ${idx}/${args.count}]    FAILED: ${message}`);
        return { ok: false, name, kind: "sandbox", error: message };
      }
    };
  });
}

function buildVolumeTasks(args: Args): Array<() => Promise<CreateResult>> {
  return Array.from({ length: args.count }, (_, i) => {
    const name = `${args.prefix}${shortId()}`;
    const idx = i + 1;
    return async () => {
      console.log(`[volume  ${idx}/${args.count}] -> CREATE ${name}`);
      try {
        await VolumeInstance.create({
          name,
          size: args.size,
          region: args.region ?? undefined,
          labels: { ...RESOURCE_LABELS },
        });
        return { ok: true, name, kind: "volume" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[volume  ${idx}/${args.count}]    FAILED: ${message}`);
        return { ok: false, name, kind: "volume", error: message };
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const total = args.kind === "both" ? args.count * 2 : args.count;

  console.log("=".repeat(72));
  console.log(`  Bulk create  --  workspace: ${args.workspace}`);
  console.log(`  Kind: ${args.kind}    Count: ${args.count}    Total resources: ${total}`);
  console.log(
    `  Concurrency: ${args.concurrency}, delay: ~${args.delayMs}-${args.delayMs + args.jitterMs}ms per launch`
  );
  console.log("=".repeat(72));

  assertWorkspaceMatches(args.workspace);

  if (!args.yes) {
    const ok = await promptYesNo(
      `About to CREATE ${total} resource(s) in workspace "${args.workspace}". Proceed? [y/N]`
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const tasks: Array<() => Promise<CreateResult>> = [];
  if (args.kind === "sandboxes" || args.kind === "both") {
    tasks.push(...buildSandboxTasks(args));
  }
  if (args.kind === "volumes" || args.kind === "both") {
    tasks.push(...buildVolumeTasks(args));
  }

  const startedAt = Date.now();
  console.log("");
  const results = await runThrottled(tasks, {
    concurrency: args.concurrency,
    delayMs: args.delayMs,
    jitterMs: args.jitterMs,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r): r is Extract<CreateResult, { ok: false }> => !r.ok);

  console.log(
    `\nDone in ${elapsedSec}s. Created ${succeeded.length}/${results.length} resource(s).`
  );
  if (failed.length > 0) {
    console.log(`Failures (${failed.length}):`);
    for (const f of failed) console.log(`  ${f.kind} ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
