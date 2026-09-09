import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Next 16 has a different advisory floor. Fail closed if the supported line changes.
function isPatchedNext15(version) {
  const match = /^15\.(\d+)\.(\d+)$/.exec(version);
  return match !== null && (Number(match[1]) > 5 || (Number(match[1]) === 5 && Number(match[2]) >= 24));
}

test("Next 15 advisory floor rejects vulnerable and unsupported releases", () => {
  for (const version of ["15.5.21", "15.5.23", "15.4.99", "16.0.0", "15.5.24-canary.1"]) {
    assert.equal(isPatchedNext15(version), false, version);
  }
  for (const version of ["15.5.24", "15.5.25", "15.6.0"]) {
    assert.equal(isPatchedNext15(version), true, version);
  }
});

test("Next fixture meets GHSA-2xp9-vwfh-vxw4 and GHSA-p293-qw3h-jr36 floors", () => {
  assert.equal(isPatchedNext15(manifest.dependencies.next), true);
  assert.equal(manifest.devDependencies["eslint-config-next"], manifest.dependencies.next);
});
