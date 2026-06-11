// Regression guard: browser / cross-runtime build safety.
//
// The browser build (fix-browser-imports.js) replaces the Node-only H2 modules
// (h2warm, h2pool, h2fetch) with hand-written stubs. If source code imports a
// symbol from one of those modules that the stub does not export, the browser,
// cloudflare-workers, and webpack bundles break with a missing-export error.
// We hit exactly this when ENG-2680 added `withUploadSlot` to h2fetch and the
// stub had to be updated to match.
//
// This test fails fast, with a clear message, whenever src imports a symbol from
// a stubbed module that the browser stub does not provide — instead of waiting
// for a confusing downstream bundle failure. No creds, no network.
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = join(here, "..", "..", "..", "@blaxel", "core");
const SRC = join(CORE, "src");
const FIX = join(CORE, "fix-browser-imports.js");

// Parse the hand-written stub definitions: module name -> set of exported names.
function parseStubExports(): Record<string, Set<string>> {
  const text = readFileSync(FIX, "utf8");
  const result: Record<string, Set<string>> = {};
  const stubRe = /name:\s*'([^']+)'[\s\S]*?js:\s*`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;
  while ((match = stubRe.exec(text)) !== null) {
    const name = match[1];
    const js = match[2];
    const names = new Set<string>();
    const exportRe = /export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g;
    let ex: RegExpExecArray | null;
    while ((ex = exportRe.exec(js)) !== null) {
      names.add(ex[1]);
    }
    result[name] = names;
  }
  return result;
}

// The Node-only modules that the browser build replaces wholesale with a stub.
// Their own imports never ship to the browser, so we do not scan them.
const STUBBED_MODULES = new Set(["h2warm", "h2pool", "h2fetch"]);

// Collect the RUNTIME named imports of `moduleBase` (e.g. "h2fetch") across src
// .ts files. Only runtime imports matter for the browser bundle: statement-level
// `import type { ... }` and inline `import { type X }` are erased at compile
// time and need no stub export, and the stubbed modules themselves are skipped.
function collectSrcImports(moduleBase: string): Set<string> {
  const imported = new Set<string>();
  // Matches `import { ... } from ".../<module>.js"` but NOT `import type { ... }`
  // (no `type` keyword is allowed between `import` and `{`).
  const importRe = new RegExp(
    "import\\s*\\{([^}]*)\\}\\s*from\\s*[\"'][^\"']*\\/" + moduleBase + "\\.js[\"']",
    "g",
  );
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts") || full.endsWith(".test.ts")) continue;
      if (STUBBED_MODULES.has(entry.replace(/\.ts$/, ""))) continue;
      const text = readFileSync(full, "utf8");
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(text)) !== null) {
        for (const raw of m[1].split(",")) {
          const trimmed = raw.trim();
          if (!trimmed || trimmed.startsWith("type ")) continue; // erased type import
          const name = trimmed.split(/\s+as\s+/)[0].trim();
          if (name) imported.add(name);
        }
      }
    }
  };
  walk(SRC);
  return imported;
}

describe("browser stub export parity (cross-runtime build safety)", () => {
  const stubs = parseStubExports();

  it("finds the H2 browser stubs in fix-browser-imports.js", () => {
    expect(Object.keys(stubs).sort()).toEqual(["h2fetch", "h2pool", "h2warm"]);
  });

  for (const moduleBase of ["h2fetch", "h2pool", "h2warm"]) {
    it(`browser stub for ${moduleBase} exports everything src imports from it`, () => {
      const stubExports = stubs[moduleBase] ?? new Set<string>();
      const imported = collectSrcImports(moduleBase);
      const missing = [...imported].filter((name) => !stubExports.has(name));
      expect(
        missing,
        `Browser stub "${moduleBase}" in fix-browser-imports.js is missing exports that src imports: [${missing.join(", ")}]. Add them to the stub, or the browser/cloudflare/webpack build will break.`,
      ).toEqual([]);
    });
  }
});
