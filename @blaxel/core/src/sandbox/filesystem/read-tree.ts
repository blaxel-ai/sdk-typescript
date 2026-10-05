import type { SandboxFileSystem } from "./filesystem.js";
import type { FilesystemReadTreeOptions } from "./types.js";

/** Thrown by `readTree` on any failure. No partial contents are returned. */
export class FilesystemReadTreeError extends Error {
  /** The relative path that could not be read (`READ` only). */
  readonly path?: string;

  constructor(
    message: string,
    readonly code: "MAX_FILES" | "DISCOVERY" | "READ",
    readonly root: string,
    { path, cause }: { path?: string; cause?: unknown } = {},
  ) {
    super(cause === undefined ? message : `${message}: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`, { cause });
    this.name = "FilesystemReadTreeError";
    this.path = path;
  }
}

export async function readTree(
  fs: Pick<SandboxFileSystem, "find" | "read">,
  root: string,
  { maxFiles = 100, concurrency = 4, ...selection }: FilesystemReadTreeOptions = {},
): Promise<Record<string, string>> {
  // find returns at most 1000 matches, so a higher cap could not detect overflow.
  if (maxFiles > 999) throw new RangeError("maxFiles must be at most 999");
  if (!(concurrency >= 1)) throw new RangeError("concurrency must be at least 1");

  let paths: string[];
  try {
    const { matches } = await fs.find(root, { ...selection, type: "file", maxResults: maxFiles + 1 });
    paths = matches.map(match => match.path).sort();
  } catch (cause) {
    throw new FilesystemReadTreeError("readTree discovery failed", "DISCOVERY", root, { cause });
  }
  if (paths.length > maxFiles) {
    throw new FilesystemReadTreeError(`readTree found more than maxFiles (${maxFiles}) files`, "MAX_FILES", root);
  }

  const dir = root.replace(/\/+$/, "");
  const contents = new Array<string>(paths.length);
  let next = 0;
  let failure: FilesystemReadTreeError | undefined;
  // Workers stop taking new files after a failure; reads already in flight finish first.
  const worker = async () => {
    while (!failure && next < paths.length) {
      const i = next++;
      try {
        contents[i] = await fs.read(`${dir}/${paths[i]}`);
      } catch (cause) {
        failure ??= new FilesystemReadTreeError(`readTree could not read ${paths[i]}`, "READ", root, { path: paths[i], cause });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  if (failure) throw failure;

  return Object.fromEntries(paths.map((path, i) => [path, contents[i]]));
}
