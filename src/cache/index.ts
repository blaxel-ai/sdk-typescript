import fs from 'fs';
import yaml from 'yaml';

const cache = new Map<string,any>()


try {
  const cacheString = fs.readFileSync('.cache.yaml', 'utf8')
  const cacheData = yaml.parseAllDocuments(cacheString)
  for (const doc of cacheData) {
    const jsonDoc = doc.toJSON()
    const cacheKey = `${jsonDoc.kind}/${jsonDoc.metadata.name}`
    cache.set(cacheKey, jsonDoc)
  }
/* eslint-disable */
} catch (error) {
}

export async function findFromCache(resource: string, name: string): Promise<any | null> {
  const cacheKey = `${resource}/${name}`
  return cache.get(cacheKey)
}