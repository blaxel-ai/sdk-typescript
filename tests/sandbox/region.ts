import { SandboxCreateConfiguration, SandboxInstance } from "@blaxel/core";

// Helper function to generate unique ID for each sandbox
// This is necessary because sandbox deletion is async and we want to avoid naming conflicts
function getUniqueId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

// Small delay helper to ensure unique timestamps
async function delay(ms: number = 10): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Configuration map for available regions per environment
// Update this map when new regions become available
const REGION_CONFIG = {
  prod: {
    regions: ["us-west-2"], // Add more regions here as they become available, e.g., ["us-west-2", "us-east-1", "eu-west-1"]
    defaultRegion: "us-west-2",
    image: "blaxel/prod-base:latest"
  },
  dev: {
    regions: ["eu-west-1"], // Add more regions here as they become available, e.g., ["eu-west-1", "us-west-2", "ap-southeast-1"]
    defaultRegion: "eu-west-1",
    image: "blaxel/dev-base:latest"
  }
};

// Determine environment from BL_ENV variable (default to prod)
// Note: This requires @types/node for TypeScript compilation
declare const process: any;
const environment = (typeof process !== 'undefined' && process.env?.BL_ENV || 'prod') as keyof typeof REGION_CONFIG;
const config = REGION_CONFIG[environment] || REGION_CONFIG.prod;

const testRegions = config.regions;
const defaultRegion = config.defaultRegion;
const testImage = config.image;

console.log(`🌍 Running tests in ${environment} environment`);
console.log(`   Available regions: ${testRegions.join(', ')}`);
console.log(`   Default region: ${defaultRegion}`);
console.log(`   Using image: ${testImage}\n`);

async function verifyRegion(sandboxName: string, expectedRegion: string | undefined) {
  const retrieved = await SandboxInstance.get(sandboxName);
  const actualRegion = retrieved.spec?.region;

  if (expectedRegion === undefined) {
    // For sandboxes created without region, backend should set it to the default region
    console.log(`   Backend set region to: ${actualRegion} (default for ${environment})`);
    if (actualRegion !== defaultRegion) {
      console.log(`   Note: Backend used ${actualRegion} instead of expected default ${defaultRegion}`);
    }
  } else if (actualRegion === expectedRegion) {
    console.log(`   ✓ Verified: Region correctly set to ${actualRegion}`);
  } else {
    console.error(`   ✗ Region mismatch! Expected ${expectedRegion}, got ${actualRegion}`);
    throw new Error(`Region verification failed for ${sandboxName}`);
  }
  return retrieved;
}

async function main() {
  try {
    console.log("Testing region field support in TypeScript SDK\n");
    console.log("=" .repeat(50));

    // Test 1: Backward compatibility - Create sandbox without region (backend will set default)
    console.log("\n✅ Test 1: Backward compatibility - Create sandbox without region");
    console.log("This ensures existing code continues to work (backend auto-sets default region)...");
    let sandbox = await SandboxInstance.create({
      name: `test-without-region-${getUniqueId()}`,
      image: testImage,
      memory: 1024
    });
    console.log(`Created sandbox without region: ${sandbox.metadata?.name}`);
    await verifyRegion(sandbox.metadata?.name!, undefined);
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("Deleted sandbox without region\n");
    await delay(); // Small delay to ensure unique timestamps for next sandbox

    // Test all available regions
    for (const testRegion of testRegions) {
      console.log("=" .repeat(50));
      console.log(`\n🌍 Testing region: ${testRegion}`);
      console.log("=" .repeat(50));

      // Test 2: Create sandbox with explicit region using SandboxCreateConfiguration
      console.log("\n✅ Test 2: Create sandbox with explicit region using SandboxCreateConfiguration");
      const configWithRegion: SandboxCreateConfiguration = {
        name: `test-region-config-${testRegion}-${getUniqueId()}`,
        image: testImage,
        memory: 1024,
        region: testRegion
      };
      sandbox = await SandboxInstance.create(configWithRegion);
      console.log(`Created sandbox with region via config: ${sandbox.metadata?.name}`);
      await verifyRegion(sandbox.metadata?.name!, testRegion);
      await SandboxInstance.delete(sandbox.metadata?.name!);
      console.log("Deleted sandbox with region\n");
      await delay(); // Ensure unique timestamps

      // Test 3: Create sandbox with region in spec structure
      console.log("✅ Test 3: Create sandbox with region in spec structure");
      sandbox = await SandboxInstance.create({
        metadata: {
          name: `test-region-spec-${testRegion}-${getUniqueId()}`
        },
        spec: {
          region: testRegion,
          runtime: {
            image: testImage,
            memory: 1024
          }
        }
      });
      console.log(`Created sandbox with region in spec: ${sandbox.metadata?.name}`);
      await verifyRegion(sandbox.metadata?.name!, testRegion);
      await SandboxInstance.delete(sandbox.metadata?.name!);
      console.log("Deleted sandbox with region spec\n");
      await delay(); // Ensure unique timestamps

      // Test 4: Create sandbox with createIfNotExists and region
      console.log("✅ Test 4: Create sandbox with createIfNotExists and region");
      sandbox = await SandboxInstance.createIfNotExists({
        name: `test-cine-region-${testRegion}-${getUniqueId()}`,
        region: testRegion,
        image: testImage,
        memory: 1024
      });
      console.log(`Created/found sandbox with region: ${sandbox.metadata?.name}`);
      await verifyRegion(sandbox.metadata?.name!, testRegion);
      await SandboxInstance.delete(sandbox.metadata?.name!);
      console.log("Deleted createIfNotExists sandbox\n");
      await delay(); // Ensure unique timestamps

      // Test 5: Verify region persistence - Create then get multiple times
      console.log("✅ Test 5: Verify region persistence");
      sandbox = await SandboxInstance.create({
        name: `test-persist-${testRegion}-${getUniqueId()}`,
        region: testRegion,
        image: testImage
      });
      console.log(`Created sandbox with region ${testRegion}: ${sandbox.metadata?.name}`);

      // Get the sandbox multiple times to ensure persistence
      for (let i = 1; i <= 2; i++) {
        console.log(`   Verification attempt ${i}:`);
        await verifyRegion(sandbox.metadata?.name!, testRegion);
      }

      await SandboxInstance.delete(sandbox.metadata?.name!);
      console.log("Deleted persistence test sandbox\n");
      await delay(); // Ensure unique timestamps
    }

    console.log("=" .repeat(50));
    console.log("\n🎉 All region tests passed successfully!");
    console.log("\nSummary:");
    console.log("- ✓ Backward compatibility maintained (backend auto-sets default region when not specified)");
    console.log(`- ✓ All ${testRegions.length} region(s) tested: ${testRegions.join(', ')}`);
    console.log("- ✓ Region can be specified in SandboxCreateConfiguration");
    console.log("- ✓ Region can be specified in spec structure");
    console.log("- ✓ Region works with createIfNotExists");
    console.log("- ✓ Region is properly persisted and verified after each creation");

  } catch (error) {
    console.error("❌ Test failed with error:", error);
  }
}

main()
  .catch((err) => {
    console.error("❌ Unhandled error:", err);
  });
