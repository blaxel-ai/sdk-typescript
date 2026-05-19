import { SandboxInstance } from "@blaxel/core";

// Goal: create one sandbox per lifecycle scenario, each with a unique name
// and a short policy so that within ~1 minute every sandbox should be
// TERMINATED by the platform. No cleanup, no in-code verification --
// we check the dashboard / `bl sandboxes list` manually.

const suffix = Date.now().toString(36);
const image = "blaxel/base-image:latest";
const region = "eu-dub-1";
const created: string[] = [];

async function create(name: string, opts: Parameters<typeof SandboxInstance.create>[0]) {
  await SandboxInstance.create(opts);
  created.push(name);
  console.log(`created ${name}`);
}

// ============================================================================
// 1. SIMPLE TTL PARAMETER (Creation)
// ============================================================================

const ttlName = `lc-ttl-${suffix}`;
await create(ttlName, {
  name: ttlName,
  image,
  region,
  ttl: "30s",
  labels: { test: "ttl" },
});

// ============================================================================
// 2. SIMPLE EXPIRES DATE PARAMETER (Creation)
// ============================================================================

const expiresName = `lc-expires-${suffix}`;
await create(expiresName, {
  name: expiresName,
  image,
  region,
  expires: new Date(Date.now() + 30_000),
  labels: { test: "expires" },
});

// ============================================================================
// 3. ADVANCED LIFECYCLE POLICIES (Creation)
// ============================================================================

// 3a. ttl-max-age (delete after total lifetime from creation)
const maxAgeName = `lc-maxage-${suffix}`;
await create(maxAgeName, {
  name: maxAgeName,
  image,
  region,
  lifecycle: {
    expirationPolicies: [
      { type: "ttl-max-age", value: "30s", action: "delete" },
    ],
  },
  labels: { test: "maxage" },
});

// 3b. ttl-idle (delete after period of inactivity)
const idleName = `lc-idle-${suffix}`;
await create(idleName, {
  name: idleName,
  image,
  region,
  lifecycle: {
    expirationPolicies: [
      { type: "ttl-idle", value: "30s", action: "delete" },
    ],
  },
  labels: { test: "idle" },
});

// 3c. date (delete at specific date/time)
const dateName = `lc-date-${suffix}`;
await create(dateName, {
  name: dateName,
  image,
  region,
  lifecycle: {
    expirationPolicies: [
      { type: "date", value: new Date(Date.now() + 30_000).toISOString(), action: "delete" },
    ],
  },
  labels: { test: "date" },
});

// 3d. multiple policies (whichever condition is met first triggers deletion)
const multiName = `lc-multi-${suffix}`;
await create(multiName, {
  name: multiName,
  image,
  region,
  lifecycle: {
    expirationPolicies: [
      { type: "ttl-idle", value: "20s", action: "delete" },
      { type: "ttl-max-age", value: "40s", action: "delete" },
    ],
  },
  labels: { test: "multi" },
});

// ============================================================================
// 4. UPDATE METHODS (Post-Creation)
// Each starts with a long TTL, then is updated to a short one so we can
// verify that the update path correctly shortens the lifecycle.
// ============================================================================

// 4a. updateTtl
const updateTtlName = `lc-update-ttl-${suffix}`;
await create(updateTtlName, {
  name: updateTtlName,
  image,
  region,
  ttl: "1h",
  labels: { test: "update-ttl" },
});
await SandboxInstance.updateTtl(updateTtlName, "30s");
console.log(`updated ttl on ${updateTtlName} -> 30s`);

// 4b. updateLifecycle (single policy)
const updateLifecycleName = `lc-update-lifecycle-${suffix}`;
await create(updateLifecycleName, {
  name: updateLifecycleName,
  image,
  region,
  ttl: "1h",
  labels: { test: "update-lifecycle" },
});
await SandboxInstance.updateLifecycle(updateLifecycleName, {
  expirationPolicies: [
    { type: "ttl-max-age", value: "30s", action: "delete" },
  ],
});
console.log(`updated lifecycle on ${updateLifecycleName} -> ttl-max-age 30s`);

// 4c. updateLifecycle (multiple policies)
const updateMultiName = `lc-update-multi-${suffix}`;
await create(updateMultiName, {
  name: updateMultiName,
  image,
  region,
  ttl: "1h",
  labels: { test: "update-multi" },
});
await SandboxInstance.updateLifecycle(updateMultiName, {
  expirationPolicies: [
    { type: "ttl-idle", value: "20s", action: "delete" },
    { type: "ttl-max-age", value: "40s", action: "delete" },
  ],
});
console.log(`updated lifecycle on ${updateMultiName} -> idle 20s / max-age 40s`);

// ============================================================================
// SUMMARY
// ============================================================================

console.log("");
console.log(`Run suffix: ${suffix}`);
console.log("Sandboxes to check (all should be TERMINATED within ~1 minute):");
for (const name of created) {
  console.log(`  - ${name}`);
}
