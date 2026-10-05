/**
 * A local process conflict, not an HTTP/API error.
 * Paths are the original request strings, not the remotely resolved child path.
 */
export class SandboxFileExistsError extends Error {
  readonly code = "FILE_ALREADY_EXISTS" as const;

  constructor(readonly source: string, readonly destination: string) {
    super(`Could not copy ${source} to ${destination}: destination already exists`);
    this.name = "SandboxFileExistsError";
  }
}

// Internal only: exported to the filesystem wrapper, never through package indexes.
// POSIX sh syntax with Linux utility options (BusyBox/GNU). Fail closed if absent.
// Only the reservation is atomic: errors/timeouts can leave a partial target.
// Never remove a target on failure; workload changes could make rollback unsafe.
export const COPY_NO_OVERWRITE_SCRIPT = `src=$1
dst=$2
case "$src" in /*) ;; *) src="./$src";; esac
case "$dst" in /*) ;; *) dst="./$dst";; esac

conflict() {
  printf '%s\\n' 'BLAXEL_CP_NO_OVERWRITE_EXISTS' >&2
  exit 73
}
claim_failed() {
  # Only a collision on the exact resolved final entry is a conflict.
  if [ -e "$target" ] || [ -L "$target" ]; then conflict; fi
  printf '%s\\n' 'Could not reserve copy destination' >&2
  exit 1
}
target=$dst
if [ -d "$dst" ]; then
  # Preserve basename edge cases "." and ".."; they resolve to existing entries.
  base=$(basename -- "$src" && printf '.') || exit 1
  base=\${base%.}
  base=\${base%?} # remove only basename's final output newline
  target=$dst/$base
fi
# Existing entries: do not follow a last-component symlink, including dangling links.
if [ -e "$target" ] || [ -L "$target" ]; then conflict; fi

if [ -L "$src" ]; then
  # -n plus a sentinel preserves trailing newlines in the actual link value.
  link=$(readlink -n -- "$src" && printf '.') || exit 1
  link=\${link%.}
  # -T is mandatory: ln -s alone may create a link INSIDE an existing directory.
  ln -sT -- "$link" "$target" || claim_failed
elif [ -d "$src" ]; then
  mode=$(stat -Lc '%a' -- "$src") || exit 1
  mask=$(umask) || exit 1
  mode=$(printf '%o' "$(( (0$mode & 0777) & ~(0$mask) ))") || exit 1
  mkdir -- "$target" || claim_failed
  # Fill the reserved root, not target/basename(src). Includes hidden entries.
  cp -r -- "$src"/. "$target" || exit 1
  chmod "$mode" -- "$target" || exit 1
elif [ -f "$src" ]; then
  # Claiming with a redirect gives 0666 & umask; recover executable rwx bits afterwards.
  mode=$(stat -Lc '%a' -- "$src") || exit 1
  mask=$(umask) || exit 1
  mode=$(printf '%o' "$(( (0$mode & 0777) & ~(0$mask) ))") || exit 1
  (set -C; : > "$target") || claim_failed
  # noclobber still opens an existing non-regular entry (e.g. a raced symlink to a device).
  if [ -L "$target" ] || [ ! -f "$target" ]; then conflict; fi
  cp -r -- "$src" "$target" || exit 1
  chmod "$mode" -- "$target" || exit 1
else
  printf '%s\\n' 'Source is missing or is not a regular file, directory, or symbolic link' >&2
  exit 1
fi
exit 0
`;
