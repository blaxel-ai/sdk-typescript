/**
 * Integration test for the certificate validation method of custom domains
 * (spec.validationMethod: "dns" default | "http").
 *
 * Names live under a throwaway, non-resolvable zone: no DNS is needed, the
 * domains never leave the "pending" state and are deleted in afterAll.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY, RUN_CUSTOM_DOMAIN_TESTS=true
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  createCustomDomain,
  deleteCustomDomain,
  getCustomDomain,
  updateCustomDomain,
} from "@blaxel/core"
import type { CustomDomain, CustomDomainWritable } from "@blaxel/core"
import { defaultLabels, isSlowTestEnabled, uniqueName } from './helpers.js'

const ZONE = "e2e-sdk.example.invalid"

function domainName(prefix: string): string {
  return `${uniqueName(prefix)}.${ZONE}`
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    return String(error.error)
  }
  return JSON.stringify(error)
}

// spec.cnameRecords is typed as a string by the spec but the API returns a
// map of record name to target.
function cnameRecords(domain: CustomDomain): Record<string, string> {
  return (domain.spec.cnameRecords ?? {}) as unknown as Record<string, string>
}

function hasAcmValidationRecord(domain: CustomDomain): boolean {
  return Object.values(cnameRecords(domain)).some((target) => target.includes("acm-validations.aws"))
}

describe.runIf(isSlowTestEnabled("RUN_CUSTOM_DOMAIN_TESTS"))('Custom domain validation method', () => {
  const created: string[] = []

  async function create(body: CustomDomainWritable) {
    const result = await createCustomDomain({ body })
    if (result.response.status === 200 && result.data?.metadata.name) {
      created.push(result.data.metadata.name)
    }
    return result
  }

  afterAll(async () => {
    await Promise.all(
      created.map(async (name) => {
        const { response } = await deleteCustomDomain({ path: { domainName: name } })
        if (response.status !== 200 && response.status !== 404) {
          console.warn(`Failed to delete custom domain ${name}: ${response.status}`)
        }
      }),
    )
  })

  // Each dns domain requests a real certificate (~40s on dev), so a single one
  // backs both the default and the immutability checks to stay under 1 minute.
  const dnsDomain = domainName("cd-dns")

  it('defaults to dns when validationMethod is omitted', async () => {
    const { data, error, response } = await create({
      metadata: { name: dnsDomain, labels: defaultLabels },
      spec: { domainType: "applications" },
    })
    expect(response.status, errorMessage(error)).toBe(200)
    expect(data?.spec.validationMethod).toBe("dns")

    const got = await getCustomDomain({ path: { domainName: dnsDomain }, throwOnError: true })
    expect(got.data.spec.validationMethod).toBe("dns")
  })

  it('accepts http on an applications domain, or refuses it when the feature flag is off', async () => {
    const name = domainName("cd-http")
    const { data, error, response } = await create({
      metadata: { name, labels: defaultLabels },
      spec: { domainType: "applications", validationMethod: "http" },
    })

    if (response.status === 403) {
      console.log(`http validation refused with 403 (feature flag off for this workspace): ${errorMessage(error)}`)
      expect(errorMessage(error)).toMatch(/http validation/i)
      return
    }

    console.log("http validation accepted (feature flag on for this workspace)")
    expect(response.status, errorMessage(error)).toBe(200)
    expect(data?.spec.validationMethod).toBe("http")
    expect(hasAcmValidationRecord(data!)).toBe(false)
    expect(cnameRecords(data!)[name]).toBeTruthy()

    const got = await getCustomDomain({ path: { domainName: name }, throwOnError: true })
    expect(got.data.spec.validationMethod).toBe("http")
    expect(hasAcmValidationRecord(got.data)).toBe(false)
  })

  it('rejects http on a previews domain', async () => {
    const { error, response } = await create({
      metadata: { name: domainName("cd-prev"), labels: defaultLabels },
      spec: { domainType: "previews", validationMethod: "http" },
    })
    expect(response.status).toBe(400)
    expect(errorMessage(error)).toMatch(/wildcard|preview/i)
  })

  it('rejects http with a wildcard SAN', async () => {
    const name = domainName("cd-san")
    const { error, response } = await create({
      metadata: { name, labels: defaultLabels },
      spec: {
        domainType: "applications",
        validationMethod: "http",
        subjectAlternativeNames: [`*.${name}`] as unknown as Array<{ [key: string]: unknown }>,
      },
    })
    expect(response.status).toBe(400)
    expect(errorMessage(error)).toMatch(/wildcard|preview/i)
  })

  it('rejects an unknown validationMethod', async () => {
    const { error, response } = await create({
      metadata: { name: domainName("cd-bad"), labels: defaultLabels },
      spec: {
        domainType: "applications",
        validationMethod: "email" as unknown as "dns",
      },
    })
    expect(response.status).toBe(400)
    expect(errorMessage(error)).toMatch(/validationMethod/)
  })

  it('keeps the existing validation method when PUT requests another one', async () => {
    const existing = await getCustomDomain({ path: { domainName: dnsDomain }, throwOnError: true })
    expect(existing.data.spec.validationMethod).toBe("dns")

    const { data, error, response } = await updateCustomDomain({
      path: { domainName: dnsDomain },
      body: {
        metadata: { name: dnsDomain, labels: defaultLabels },
        spec: { domainType: "applications", region: existing.data.spec.region, validationMethod: "http" },
      },
    })
    expect(response.status, errorMessage(error)).toBe(200)
    expect(data?.spec.validationMethod).toBe("dns")

    const got = await getCustomDomain({ path: { domainName: dnsDomain }, throwOnError: true })
    expect(got.data.spec.validationMethod).toBe("dns")
  })
})
