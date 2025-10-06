import yaml from "yaml";
// Avoid static import of Node built-ins in browser bundles
type FsLike = { readFileSync(path: string, encoding: string): string } | null;
let fs: FsLike = null;
try {
  const isNode = typeof process !== "undefined" && typeof (process as any).versions?.node === "string";
  const isBrowser = typeof globalThis !== "undefined" && typeof (globalThis as any)?.window !== "undefined";
  if (isNode && !isBrowser) {
    const req = (eval("require") as unknown as (id: string) => unknown);
    const loaded = req("fs") as { readFileSync(path: string, encoding: string): string };
    fs = loaded;
  }
} catch {
  // ignore
}

const cache = new Map<string, any>();

try {
  if (fs !== null) {
    const cacheString = fs.readFileSync(".cache.yaml", "utf8");
    const cacheData = yaml.parseAllDocuments(cacheString);
    for (const doc of cacheData) {
      type JsonDoc = {
        kind: string;
        metadata: {
          name: string;
        };
      };
      const jsonDoc = doc.toJSON() as unknown as JsonDoc;
      const cacheKey = `${jsonDoc.kind}/${jsonDoc.metadata.name}`;
      cache.set(cacheKey, jsonDoc);
    }
  }
  /* eslint-disable */
} catch (error) {}

export async function findFromCache(
  resource: string,
  name: string
): Promise<unknown | null> {
  const cacheKey = `${resource}/${name}`;
  return cache.get(cacheKey);
}
