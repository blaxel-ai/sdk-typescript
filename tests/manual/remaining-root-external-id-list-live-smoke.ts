import '@blaxel/core'

import {
  listAgents,
  listFunctions,
  listIntegrationConnections,
  listJobs,
  listModels,
  listPolicies,
} from '../../@blaxel/core/dist/esm/client/index.js'

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const missing = `missing-${suffix}`

async function main() {
  const checks = [
    ['agents', () => listAgents({ query: { externalId: missing, limit: 1 }, throwOnError: true })],
    ['functions', () => listFunctions({ query: { externalId: missing, limit: 1 }, throwOnError: true })],
    ['integrationConnections', () => listIntegrationConnections({ query: { externalId: missing }, throwOnError: true })],
    ['jobs', () => listJobs({ query: { externalId: missing, limit: 1 }, throwOnError: true })],
    ['models', () => listModels({ query: { externalId: missing, limit: 1 }, throwOnError: true })],
    ['policies', () => listPolicies({ query: { externalId: missing, limit: 1 }, throwOnError: true })],
  ] as const

  for (const [label, check] of checks) {
    await check()
    console.log(`${label} externalId list filter smoke passed`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
