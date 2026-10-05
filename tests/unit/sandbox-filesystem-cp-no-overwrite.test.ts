import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { SandboxFileExistsError, SandboxFileSystem } from "@blaxel/core";
import { COPY_NO_OVERWRITE_SCRIPT } from "../../@blaxel/core/src/sandbox/filesystem/copy-no-overwrite.js";
import { shellQuote } from "../../@blaxel/core/src/common/shell.js";

const marker = "BLAXEL_CP_NO_OVERWRITE_EXISTS";
type Result = { status: string; logs?: string; exitCode: number };
type Harness = Pick<SandboxFileSystem, "cp"> & {
  process: {
    exec: (request: { command: string }) => Promise<{ pid: string }>;
    wait: (pid: string, options: { maxWait: number; interval: number }) => Promise<Result>;
  };
};
function harness(result: Result = { status: "completed", logs: "", exitCode: 0 }) {
  const filesystem = Object.create(SandboxFileSystem.prototype) as Harness;
  const exec = vi.fn<Harness["process"]["exec"]>().mockResolvedValue({ pid: "pid-1" });
  const wait = vi.fn<Harness["process"]["wait"]>().mockResolvedValue(result);
  filesystem.process = { exec, wait };
  return { filesystem, exec, wait };
}

describe("SandboxFileSystem.cp noOverwrite protocol", () => {
  it.each([undefined, false])("preserves default command, wait and response: %s", async noOverwrite => {
    const { filesystem, exec, wait } = harness();
    expect(await filesystem.cp("source", "destination", { noOverwrite })).toEqual({ message: "Files copied", source: "source", destination: "destination" });
    expect(exec).toHaveBeenCalledExactlyOnceWith({ command: "cp -r 'source' 'destination'" });
    expect(wait).toHaveBeenCalledExactlyOnceWith("pid-1", { maxWait: 180000, interval: 100 });
  });
  it("preserves an omitted options argument and default generic failure text", async () => {
    const { filesystem, exec, wait } = harness({ status: "failed", logs: "bad copy", exitCode: 73 });
    await expect(filesystem.cp("source", "destination")).rejects.toThrow("Could not copy source to destination cause: bad copy");
    expect(exec).toHaveBeenCalledExactlyOnceWith({ command: "cp -r 'source' 'destination'" });
    expect(wait).toHaveBeenCalledExactlyOnceWith("pid-1", { maxWait: 180000, interval: 100 });
  });
  it("uses a quoted fixed script and positional arguments, with original response paths", async () => {
    const { filesystem, exec, wait } = harness();
    const source = "-source ' ; $(touch BAD)\nユニコード";
    const destination = "-destination ' ; touch BAD\n";
    expect(await filesystem.cp(source, destination, { noOverwrite: true, maxWait: 321 })).toEqual({ message: "Files copied", source, destination });
    expect(exec).toHaveBeenCalledExactlyOnceWith({ command: `sh -c ${shellQuote(COPY_NO_OVERWRITE_SCRIPT)} sh ${shellQuote(source)} ${shellQuote(destination)}` });
    expect(wait).toHaveBeenCalledExactlyOnceWith("pid-1", { maxWait: 321, interval: 100 });
  });
  it.each([["", "dst"], ["src", ""], ["a\0b", "dst"], ["src", "a\0b"]])("validates protected paths before exec: %j", async (source, destination) => {
    const { filesystem, exec, wait } = harness();
    await expect(filesystem.cp(source, destination, { noOverwrite: true })).rejects.toThrow(new RangeError("source and destination must be nonempty paths without NUL bytes"));
    expect(exec).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  });
  it("exports a local Error, not an HTTP conflict, only on failed73+exact marker", async () => {
    const { filesystem } = harness({ status: "failed", exitCode: 73, logs: `diagnostic\n${marker}\n` });
    const error = await filesystem.cp("original-source", "container", { noOverwrite: true }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SandboxFileExistsError);
    expect(error).toMatchObject({ name: "SandboxFileExistsError", code: "FILE_ALREADY_EXISTS", source: "original-source", destination: "container", message: "Could not copy original-source to container: destination already exists" });
    expect(error).not.toHaveProperty("status"); expect(error).not.toHaveProperty("response"); expect(error).not.toHaveProperty("retryAfter");
  });
  it.each([
    { status: "failed", exitCode: 73, logs: "File exists" },
    { status: "failed", exitCode: 73, logs: undefined },
    { status: "failed", exitCode: 73, logs: `prefix ${marker}\n` },
    { status: "failed", exitCode: 73, logs: `${marker} suffix\n` },
    { status: "failed", exitCode: 1, logs: `${marker}\n` },
    { status: "failed", exitCode: 1, logs: "Permission denied" },
    { status: "failed", exitCode: 1, logs: "Missing parent" },
    { status: "completed", exitCode: 73, logs: `${marker}\n` },
    { status: "running", exitCode: 0, logs: "pending" },
    { status: "unknown", exitCode: 0, logs: "unknown" },
    { status: "killed", exitCode: 0, logs: "killed" },
    { status: "stopped", exitCode: 0, logs: "stopped" },
  ])("fails generically and never reports false success: %j", async result => {
    const { filesystem, exec, wait } = harness(result);
    const error = await filesystem.cp("src", "dst", { noOverwrite: true }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(SandboxFileExistsError);
    expect(error).toHaveProperty("message", `Could not copy src to dst cause: ${result.logs}`);
    expect(exec).toHaveBeenCalledTimes(1); expect(wait).toHaveBeenCalledTimes(1);
  });
  it.each(["exec", "wait"] as const)("propagates %s API/transport/timeout errors without retry or cleanup", async phase => {
    const { filesystem, exec, wait } = harness();
    const failure = new Error("transport or wait timeout");
    if (phase === "exec") exec.mockRejectedValueOnce(failure);
    else wait.mockRejectedValueOnce(failure);
    await expect(filesystem.cp("src", "dst", { noOverwrite: true })).rejects.toBe(failure);
    expect(exec).toHaveBeenCalledTimes(1); expect(wait).toHaveBeenCalledTimes(phase === "exec" ? 0 : 1);
  });
});

// The shell matrix runs natively on Linux. On macOS, opt into the same test with
// CP_NO_OVERWRITE_DOCKER_IMAGE=alpine:3.21 (or either tested Debian image).
// This is a test harness switch, not an SDK option or a runtime dependency.
const dockerImage = process.env.CP_NO_OVERWRITE_DOCKER_IMAGE;
describe.runIf((process.platform === "linux" && process.getuid?.() !== 0) || Boolean(dockerImage))("exclusive copy Linux shell matrix", () => {
  it("executes source/effective-target/failure/mode/race cases as a non-root user", () => {
    // Colima shares the checkout, but not macOS /var/folders temporary paths.
    const directory = mkdtempSync(join(dockerImage ? process.cwd() : tmpdir(), ".cp-no-overwrite-"));
    try {
      writeFileSync(join(directory, "copy.sh"), COPY_NO_OVERWRITE_SCRIPT);
      writeFileSync(join(directory, "matrix.sh"), platformMatrix);
      // macOS temporary dirs default 0700; Docker's non-root test user needs traversal.
      chmodSync(directory, 0o755);
      const result = dockerImage
        ? spawnSync("docker", ["run", "--rm", "--user", "65534:65534", "-v", `${directory}:/spec:ro`, dockerImage, "sh", "/spec/matrix.sh", "/spec/copy.sh"], { encoding: "utf8", timeout: 30_000 })
        : spawnSync("sh", [join(directory, "matrix.sh"), join(directory, "copy.sh")], { encoding: "utf8", timeout: 30_000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("PASS");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35_000);
});

// Defined below so the wrapper tests remain easy to review.
const platformMatrix = `#!/bin/sh
set -eu
copy_script=$1
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
cd "$d"
cpn() { sh "$copy_script" "$1" "$2"; }
blocked() {
  set +e
  cpn "$1" "$2" > log 2>&1
  status=$?
  set -e
  test "$status" = 73
  grep -qx 'BLAXEL_CP_NO_OVERWRITE_EXISTS' log
}
printf '%s' new > src
printf '%s' old > existing
blocked src existing
test "$(cat existing)" = old
ln -s missing dangling
blocked src dangling
test -L dangling
mkdir container
cpn src container
test "$(cat container/src)" = new
blocked src container
mkdir tree
printf hidden > tree/.hidden
mkdir tree/sub
printf data > tree/sub/a
ln -s sub/a tree/link
cpn tree container
test "$(cat container/tree/.hidden)" = hidden
test "$(cat container/tree/sub/a)" = data
test -L container/tree/link
blocked tree container
cpn tree fresh-tree
test -f fresh-tree/sub/a
test ! -e fresh-tree/tree
ln -s 'a b' src-link
cpn src-link link-copy
test "$(readlink link-copy)" = 'a b'
ln -s 'directory' link-as-file
blocked src link-as-file
ln -s container directory-link
blocked src directory-link
mkdir -p link-container/src-link
blocked src-link link-container
test ! -e link-container/src-link/'a b'
link_value=$(printf 'trailing\\n\\n.')
link_value=\${link_value%.}
ln -s "$link_value" newline-link
cpn newline-link newline-copy
test "$(readlink newline-link && printf '.')" = "$(readlink newline-copy && printf '.')"
chmod 751 src
umask 027
cpn src mode-file
test "$(stat -c %a mode-file)" = 750
# The reserved directory root must recover the source's restrictive mode.
mkdir private-tree
printf private > private-tree/file
chmod 700 private-tree
cp -r private-tree reference-private-tree
cpn private-tree protected-private-tree
test "$(stat -c %a protected-private-tree)" = 700
test "$(stat -c %a protected-private-tree)" = "$(stat -c %a reference-private-tree)"
test "$(cat protected-private-tree/file)" = private
printf special > "./--input 'quoted' ; touch BAD"
cpn "./--input 'quoted' ; touch BAD" "./--output 'quoted' ; touch BAD"
test ! -e BAD
test "$(cat "./--output 'quoted' ; touch BAD")" = special
printf nl > "$(printf 'newline\\nfile')"
cpn "$(printf 'newline\\nfile')" "$(printf 'newline\\ncopy')"
test "$(cat "$(printf 'newline\\ncopy')")" = nl
tail_name=$(printf 'name-tail\\n.')
tail_name=\${tail_name%.}
printf tail > "$tail_name"
mkdir tail-container
cpn "$tail_name" tail-container
test "$(cat "tail-container/$tail_name")" = tail
set +e
cpn src missing-parent/target > log 2>&1; status=$?
set -e
test "$status" = 1
! grep -qx BLAXEL_CP_NO_OVERWRITE_EXISTS log
test ! -e missing-parent
set +e
cpn absent absent-target > log 2>&1; status=$?
set -e
test "$status" = 1
test ! -e absent-target
mkfifo fifo
set +e
cpn fifo fifo-target > log 2>&1; status=$?
set -e
test "$status" = 1
test ! -e fifo-target
# Stable effective paths, no removals: exactly one winner of 24 contenders.
# Directory contenders must use a pre-existing destination container: a newly
# created raw destination directory becomes a cp container for later calls.
mkdir race-directory-container
for type in file directory link; do
  destination="race-$type"
  case "$type" in file) source=src;; directory) source=tree; destination=race-directory-container;; link) source=src-link;; esac
  i=0
  while test "$i" -lt 24; do
    (set +e; cpn "$source" "$destination" > "race-$type-$i.log" 2>&1; printf '%s\\n' "$?" > "race-$type-$i.status") &
    i=$((i+1))
  done
  wait
  winners=0
  conflicts=0
  for statusfile in race-"$type"-*.status; do
    status=$(cat "$statusfile")
    case "$status" in 0) winners=$((winners+1));; 73) conflicts=$((conflicts+1));; *) printf 'unexpected status %s\\n' "$status"; exit 1;; esac
  done
  test "$winners" = 1
  test "$conflicts" = 23
  printf 'race %s: winners=%s conflicts=%s\\n' "$type" "$winners" "$conflicts"
done
printf 'PASS: conflicts, effective directory targets, recursive content, symlinks, modes, quoting, missing parents/sources, FIFO rejection\\n'

# Additional implementation acceptance coverage beyond the feasibility probe.
generic() {
  set +e
  cpn "$1" "$2" > log 2>&1
  status=$?
  set -e
  test "$status" = 1
  ! grep -qx BLAXEL_CP_NO_OVERWRITE_EXISTS log
}
blocked src src
ln src hard-alias
blocked src hard-alias
test "$(cat src)" = new
ln -s src file-alias
blocked src file-alias
test "$(readlink file-alias)" = src
mkdir untouched-root
printf original > untouched-root/keep
blocked tree/. untouched-root
test "$(cat untouched-root/keep)" = original
test ! -e untouched-root/.hidden
blocked . untouched-root
blocked .. untouched-root
blocked tree/ container
cpn tree/. dot-tree
test -f dot-tree/sub/a
test ! -e dot-tree/tree
mkdir trailing-container
cpn tree/ trailing-container
test -f trailing-container/tree/sub/a
ln -s tree directory-source-link
mkdir followed-container
cpn directory-source-link/ followed-container
test -d followed-container/directory-source-link
test ! -L followed-container/directory-source-link
test -f followed-container/directory-source-link/sub/a
generic src absent-slash/
test ! -e absent-slash
ln -s nonexistent dangling-parent
generic src dangling-parent/child
test ! -e dangling-parent/child
mkdir locked
chmod 555 locked
generic src locked/child
chmod 755 locked
generic /dev/null device-target
test ! -e device-target

# Ordinary rwx matches new-file cp-r, but protected copies strip special bits.
cp -r src reference-mode
cpn src protected-mode
test "$(stat -c %a reference-mode)" = "$(stat -c %a protected-mode)"
chmod 6751 src
cpn src no-special-bits
test "$(stat -c %a no-special-bits)" = 750

# Missing required utilities fail before creating an unprotected target.
set +e
PATH=/nonexistent /bin/sh "$copy_script" src no-tools > log 2>&1
status=$?
set -e
test "$status" = 1
test ! -e no-tools

# A utility's exit73 and arbitrary marker logs cannot impersonate a conflict.
mkdir fakebin
printf '#!/bin/sh\\nprintf "BLAXEL_CP_NO_OVERWRITE_EXISTS\\\\n" >&2\\nexit 73\\n' > fakebin/cp
chmod 755 fakebin/cp
set +e
PATH="$d/fakebin:$PATH" cpn src partial-file > log 2>&1
status=$?
set -e
test "$status" = 1
test -f partial-file
test ! -s partial-file
blocked src partial-file
set +e
PATH="$d/fakebin:$PATH" cpn src existing > log 2>&1
status=$?
set -e
test "$status" = 73
test "$(cat existing)" = old
mkdir partial-container
set +e
PATH="$d/fakebin:$PATH" cpn tree partial-container > log 2>&1
status=$?
set -e
test "$status" = 1
test -d partial-container/tree
test ! -e partial-container/tree/.hidden
blocked tree partial-container

# Deterministically create a directory after the initial check but before ln.
# ln -s without mandatory -T would silently create a child and report success.
printf '#!/bin/sh\\n"%s" "$@" || exit 1\\n"%s" -- "$CLAIM_RACE_TARGET" || exit 1\\n' "$(command -v readlink)" "$(command -v mkdir)" > fakebin/readlink
chmod 755 fakebin/readlink
set +e
CLAIM_RACE_TARGET="$d/late-directory" PATH="$d/fakebin:$PATH" cpn src-link late-directory > log 2>&1
status=$?
set -e
test "$status" = 73
test -d late-directory
test ! -L 'late-directory/a b'
mkdir late-real-directory
printf '#!/bin/sh\\n"%s" "$@" || exit 1\\n"%s" -s -- "$LATE_CONTAINER" "$CLAIM_RACE_TARGET" || exit 1\\n' "$(command -v readlink)" "$(command -v ln)" > fakebin/readlink
set +e
LATE_CONTAINER="$d/late-real-directory" CLAIM_RACE_TARGET="$d/late-directory-link" PATH="$d/fakebin:$PATH" cpn src-link late-directory-link > log 2>&1
status=$?
set -e
test "$status" = 73
test -L late-directory-link
test ! -L 'late-real-directory/a b'

# Race a symlink to a device in after the pre-check, from the source stat shim.
# set -C opens it, so the post-claim check must reject it before cp/chmod.
mkdir stat-race-bin
printf '#!/bin/sh\\n"%s" "$@" || exit 1\\n"%s" -s -- /dev/null "$CLAIM_RACE_TARGET" || exit 1\\n' "$(command -v stat)" "$(command -v ln)" > stat-race-bin/stat
chmod 755 stat-race-bin/stat
device_mode=$(stat -c %a /dev/null)
set +e
CLAIM_RACE_TARGET="$d/late-device-link" PATH="$d/stat-race-bin:$PATH" cpn src late-device-link > log 2>&1
status=$?
set -e
test "$status" = 73
grep -qx BLAXEL_CP_NO_OVERWRITE_EXISTS log
test -L late-device-link
test "$(readlink late-device-link)" = /dev/null
test "$(stat -c %a /dev/null)" = "$device_mode"
printf 'PASS: raced device symlink preserved, restrictive directory mode restored\\n'

# Mixed source types claim exactly the same stable entry; ln -T must not nest.
mkdir mixed-container
i=0
while test "$i" -lt 24; do
  mkdir "mixed-$i"
  case "$((i % 3))" in
    0) printf mixed > "mixed-$i/same";;
    1) mkdir "mixed-$i/same"; printf hidden > "mixed-$i/same/.hidden";;
    2) ln -s do-not-nest "mixed-$i/same";;
  esac
  (set +e; cpn "mixed-$i/same" mixed-container > "mixed-$i.log" 2>&1; printf '%s\\n' "$?" > "mixed-$i.status") &
  i=$((i+1))
done
wait
winners=0
conflicts=0
for statusfile in mixed-*.status; do
  status=$(cat "$statusfile")
  case "$status" in 0) winners=$((winners+1));; 73) conflicts=$((conflicts+1));; *) exit 1;; esac
done
test "$winners" = 1
test "$conflicts" = 23
test ! -e mixed-container/same/do-not-nest
printf 'race mixed: winners=%s conflicts=%s\\n' "$winners" "$conflicts"
printf 'PASS: aliases, dot/trailing-slash paths, mode safety, missing tools, partial retention, mixed race\\n'
`;
