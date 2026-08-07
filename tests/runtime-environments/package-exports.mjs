import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const coreDir = join(repoRoot, "@blaxel", "core");
const tempDir = mkdtempSync(join(tmpdir(), "blaxel-core-package-"));

try {
  execFileSync("npm", ["run", "build"], { cwd: coreDir, stdio: "inherit" });
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", tempDir],
    { cwd: coreDir, encoding: "utf8" },
  );
  const [{ filename }] = Object.values(JSON.parse(packOutput));
  execFileSync("tar", ["-xzf", join(tempDir, filename)], { cwd: tempDir });

  const consumerDir = join(tempDir, "consumer");
  const packageDir = join(consumerDir, "node_modules", "@blaxel", "core");
  mkdirSync(dirname(packageDir), { recursive: true });
  renameSync(join(tempDir, "package"), packageDir);
  symlinkSync(join(coreDir, "node_modules"), join(packageDir, "node_modules"), "dir");

  const check = `
    if (typeof h2TransportStats?.snapshot !== "function") throw new Error("snapshot export missing");
    if (typeof h2TransportStats?.reset !== "function") throw new Error("reset export missing");
  `;
  execFileSync(
    "node",
    ["--input-type=module", "-e", `import { h2TransportStats } from "@blaxel/core"; ${check}`],
    { cwd: consumerDir, stdio: "inherit" },
  );
  execFileSync(
    "node",
    ["-e", `const { h2TransportStats } = require("@blaxel/core"); ${check}`],
    { cwd: consumerDir, stdio: "inherit" },
  );

  stdout.write("Packed @blaxel/core ESM and CJS exports OK\n");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
