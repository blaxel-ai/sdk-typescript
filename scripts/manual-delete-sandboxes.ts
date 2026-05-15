#!/usr/bin/env -S npx tsx
/* eslint-disable no-console */
/**
 * manual-delete-sandboxes.ts
 * =========================================================================
 * Manually delete EVERY non-terminated sandbox in a Blaxel workspace.
 *
 * This script intentionally has NO filtering flags. It lists everything
 * the workspace returns, drops sandboxes that are already TERMINATED
 * (those have no remaining state to delete), prints the full list for
 * review, and then deletes them one by one with a pause between calls
 * so the WAF / rate limiter does not flag the traffic as a burst.
 *
 * If you do not want to delete all of them, stop after the dry run and
 * narrow your account / workspace down by other means before re-running.
 *
 * Authentication
 * --------------
 * Uses the standard `@blaxel/core` credential chain:
 *   - BL_API_KEY + BL_WORKSPACE env vars, OR
 *   - `~/.blaxel/config.yaml` (created by `bl login`).
 *
 * Workspace targeting
 * -------------------
 * The first positional argument MUST be the workspace name. The script
 * refuses to run if the resolved active workspace does not match. To
 * switch, run:
 *
 *     bl workspaces <workspace>     (alias: bl ws <workspace>)
 *
 * or set `BL_WORKSPACE=<workspace>` in the environment. We do not
 * silently switch -- you must do it explicitly.
 *
 * Usage
 * -----
 *     npx tsx scripts/manual-delete-sandboxes.ts <workspace> [flags]
 *     bun run scripts/manual-delete-sandboxes.ts <workspace> [flags]
 *
 * Flags
 * -----
 *   --delay-ms <n>       Base delay between deletions. Default: 400ms.
 *   --jitter-ms <n>      Random extra delay 0..jitter. Default: 200ms.
 *                        Together this gives 400-600ms between calls,
 *                        ~100 deletions/min, well under any rate limit.
 *   --confirm            Actually issue DELETE calls. Without this flag
 *                        the script runs as a DRY RUN and exits.
 *   --yes                Skip the interactive y/N prompt (use with
 *                        --confirm in automated contexts).
 *
 * Recommended workflow
 * --------------------
 *   1. Dry-run first:
 *        npx tsx scripts/manual-delete-sandboxes.ts my-ws
 *   2. Inspect the printed list and the workspace name in the banner.
 *   3. Re-run with --confirm. You will be prompted to type:
 *        DELETE <workspace>
 *      before any destructive call runs.
 * =========================================================================
 */

import { SandboxInstance, settings } from "@blaxel/core";
import readline from "node:readline/promises";

// ---------------------------------------------------------------------------
// Argv parsing (kept inline so this script is single-file droppable).
// ---------------------------------------------------------------------------

type Args = {
  workspace: string;
  delayMs: number;
  jitterMs: number;
  confirm: boolean;
  yes: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Args = {
    workspace: "",
    delayMs: 400,
    jitterMs: 200,
    confirm: false,
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
      case "--delay-ms":
        args.delayMs = Number(next());
        break;
      case "--jitter-ms":
        args.jitterMs = Number(next());
        break;
      case "--confirm":
        args.confirm = true;
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

  if (positional.length !== 1) {
    printHelpAndExit(1, "Exactly one positional argument is required: <workspace>");
  }
  args.workspace = positional[0];
  return args;
}

function printHelpAndExit(code: number, msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error("Usage: manual-delete-sandboxes.ts <workspace> [flags]");
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
// Pretty printing.
// ---------------------------------------------------------------------------

type MinimalSandbox = {
  name: string;
  status?: string;
  createdAt?: string;
};

function toMinimal(sb: SandboxInstance): MinimalSandbox {
  return {
    name: sb.metadata?.name ?? "",
    status: sb.status as string | undefined,
    createdAt: (sb.metadata as { createdAt?: string } | undefined)?.createdAt,
  };
}

function printPreview(items: MinimalSandbox[]): void {
  console.log(`\nFound ${items.length} sandbox(es) to delete (oldest first):\n`);
  for (const sb of items) {
    console.log(
      `  ${(sb.status ?? "?").padEnd(11)} ${(sb.createdAt ?? "?").padEnd(25)} ${sb.name}`
    );
  }
  console.log("");
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("=".repeat(72));
  console.log(`  Manual sandbox deletion  --  workspace: ${args.workspace}`);
  console.log(`  Mode: ${args.confirm ? "EXECUTE (will issue DELETE calls)" : "DRY RUN (no changes)"}`);
  console.log("=".repeat(72));

  assertWorkspaceMatches(args.workspace);

  console.log("\nListing sandboxes...");
  const all = (await SandboxInstance.list()).map(toMinimal);
  // Sandboxes already in TERMINATED state have no remaining state to delete,
  // so calling DELETE on them is wasted traffic.
  const targets = all
    .filter((sb) => sb.status !== "TERMINATED")
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const terminatedCount = all.length - targets.length;
  console.log(
    `  workspace has ${all.length} sandbox(es) (${terminatedCount} already TERMINATED, skipped).`
  );

  printPreview(targets);

  if (targets.length === 0) {
    console.log("Nothing to delete. Exiting.");
    return;
  }

  if (!args.confirm) {
    console.log(
      "Dry run complete. Re-run with --confirm to actually delete the sandboxes above."
    );
    return;
  }

  if (!args.yes) {
    const yn = (
      await promptLine(
        `About to DELETE ${targets.length} sandbox(es) from workspace "${args.workspace}". Proceed? [y/N]`
      )
    ).toLowerCase();
    if (yn !== "y" && yn !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  // Extra safety: require typing the exact phrase. Same pattern GitHub /
  // AWS use for destructive operations. It also defeats accidental
  // copy-paste of an old command.
  const phrase = `DELETE ${args.workspace}`;
  const typed = await promptLine(`Type "${phrase}" to confirm:`);
  if (typed !== phrase) {
    console.log("Phrase did not match. Aborted.");
    return;
  }

  console.log(
    `\nDeleting with ~${args.delayMs}-${args.delayMs + args.jitterMs}ms between calls...\n`
  );
  const failures: { name: string; error: string }[] = [];
  let done = 0;
  for (const sb of targets) {
    done++;
    const prefix = `[${done}/${targets.length}]`;
    // Print BEFORE making the call so a Ctrl-C log clearly shows what was attempted.
    console.log(`${prefix} -> DELETE ${sb.name}`);
    try {
      await SandboxInstance.delete(sb.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`${prefix}    FAILED: ${message}`);
      failures.push({ name: sb.name, error: message });
    }
    if (done < targets.length) {
      await sleep(args.delayMs + Math.floor(Math.random() * args.jitterMs));
    }
  }

  console.log(
    `\nDone. Deleted ${targets.length - failures.length}/${targets.length} sandbox(es).`
  );
  if (failures.length > 0) {
    console.log(`Failures (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
