import fs from "fs";
import yaml from "yaml";

const cache = new Map<string, any>();

try {
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
  /* eslint-disable */
} catch (error) {}

export async function findFromCache(
  resource: string,
  name: string
): Promise<unknown | null> {
  const cacheKey = `${resource}/${name}`;
  return cache.get(cacheKey);
}
