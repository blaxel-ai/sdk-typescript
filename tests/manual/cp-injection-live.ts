// Live verification of the cp() shell-injection fix against a real sandbox.
// Run: npx tsx tests/manual/cp-injection-live.ts
import { SandboxInstance } from "@blaxel/core";

const NAME = `cp-inject-${Date.now()}`;
const DIR = "/verify";

async function sh(sandbox: SandboxInstance, command: string) {
  const p = await sandbox.process.exec({ command, waitForCompletion: true });
  return { status: p.status, logs: (p.logs ?? "").trim() };
}

async function exists(sandbox: SandboxInstance, path: string) {
  const r = await sh(sandbox, `test -e ${path} && echo YES || echo NO`);
  return r.logs.includes("YES");
}

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail: string) {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}`);
}

const sandbox = await SandboxInstance.createIfNotExists({
  name: NAME,
  image: "blaxel/node:latest",
  memory: 2048,
  ttl: "10m",
});
console.log(`sandbox: ${NAME}`);

try {
  await sh(sandbox, `mkdir -p '${DIR}'`);
  await sh(sandbox, `echo hello-from-source > ${DIR}/src.txt`);

  // 1. Ordinary copy still works.
  await sandbox.fs.cp(`${DIR}/src.txt`, `${DIR}/dst.txt`);
  const copied = await sh(sandbox, `cat ${DIR}/dst.txt`);
  record(
    "ordinary copy still works",
    copied.logs === "hello-from-source",
    `cat dst.txt -> ${JSON.stringify(copied.logs)}`,
  );

  // 2. Injected command in the source path must not run.
  const payload = `${DIR}/src.txt; touch ${DIR}/pwned-source`;
  try {
    await sandbox.fs.cp(payload, `${DIR}/out1`);
  } catch (e) {
    console.log(`      (cp threw, expected: ${(e as Error).message.slice(0, 90)})`);
  }
  const pwnedSource = await exists(sandbox, `${DIR}/pwned-source`);
  record(
    "injection via source path does not execute",
    !pwnedSource,
    `${DIR}/pwned-source exists: ${pwnedSource}`,
  );

  // 3. Injected command in the destination path must not run.
  const payload2 = `${DIR}/out2; touch ${DIR}/pwned-dest`;
  try {
    await sandbox.fs.cp(`${DIR}/src.txt`, payload2);
  } catch (e) {
    console.log(`      (cp threw, expected: ${(e as Error).message.slice(0, 90)})`);
  }
  const pwnedDest = await exists(sandbox, `${DIR}/pwned-dest`);
  record(
    "injection via destination path does not execute",
    !pwnedDest,
    `${DIR}/pwned-dest exists: ${pwnedDest}`,
  );

  // 4. Command substitution must not run either.
  try {
    await sandbox.fs.cp(`$(touch ${DIR}/pwned-subst)`, `${DIR}/out3`);
  } catch (e) {
    console.log(`      (cp threw, expected: ${(e as Error).message.slice(0, 90)})`);
  }
  const pwnedSubst = await exists(sandbox, `${DIR}/pwned-subst`);
  record(
    "command substitution does not execute",
    !pwnedSubst,
    `${DIR}/pwned-subst exists: ${pwnedSubst}`,
  );

  // 5. A path with a space is now a single argument, so this copy succeeds.
  await sh(sandbox, `mkdir -p '${DIR}/with space'`);
  await sandbox.fs.cp(`${DIR}/src.txt`, `${DIR}/with space/copied.txt`);
  const spaced = await sh(sandbox, `cat '${DIR}/with space/copied.txt'`);
  record(
    "path containing a space copies correctly",
    spaced.logs === "hello-from-source",
    `cat 'with space/copied.txt' -> ${JSON.stringify(spaced.logs)}`,
  );

  const listing = await sh(sandbox, `ls -A ${DIR}`);
  console.log(`\nfinal ${DIR} listing:\n${listing.logs}`);
} finally {
  await SandboxInstance.delete(NAME);
  console.log(`\ndeleted sandbox: ${NAME}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
