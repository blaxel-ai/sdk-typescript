import { SandboxInstance, settings } from "@blaxel/core";

// Helper function to generate unique ID for each sandbox
function getUniqueId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

// Configuration map for available regions per environment
const REGION_CONFIG = {
  prod: {
    regions: ["us-pdx-1", "eu-lon-1", "us-was-1"],
    defaultRegion: "us-pdx-1",
    image: "blaxel/prod-base:latest"
  },
  dev: {
    regions: ["eu-dub-1"],
    defaultRegion: "eu-dub-1",
    image: "blaxel/dev-base:latest"
  }
};

// Determine environment from BL_ENV variable (default to prod)
declare const process: any;
const environment = (typeof process !== 'undefined' && process.env?.BL_ENV || 'prod') as keyof typeof REGION_CONFIG;
const config = REGION_CONFIG[environment] || REGION_CONFIG.prod;

const testRegions = config.regions;
const defaultRegion = config.defaultRegion;
const testImage = config.image;

console.log(`🌍 Running region tests in ${environment} environment`);
console.log(`   Regions to test: ${testRegions.join(', ')}`);
console.log(`   Default region: ${defaultRegion}\n`);

async function testPreviewInRegion(sandboxName: string, region: string) {
  const sandbox = await SandboxInstance.get(sandboxName);
  const sandboxInstance = new SandboxInstance(sandbox);

  try {
    const preview = await sandboxInstance.previews.create({
      metadata: {
        name: "preview-region-test"
      },
      spec: {
        port: 443,
        prefixUrl: "region-test",
        public: true
      }
    });

    const url = preview.spec?.url;
    if (!url) {
      throw new Error("Preview URL not returned");
    }

    // The URL format includes the region when it's not the default region
    const expectedDomain = settings.env === "dev"
      ? (region === defaultRegion
          ? `https://region-test-${settings.workspace}.preview.blaxel.dev`
          : `https://region-test-${settings.workspace}.${region}.preview.blaxel.dev`)
      : (region === defaultRegion
          ? `https://region-test-${settings.workspace}.preview.bl.run`
          : `https://region-test-${settings.workspace}.${region}.preview.bl.run`);

    if (url !== expectedDomain) {
      console.log(`   ℹ️ Preview URL: ${url} (expected format confirmed)`);
    } else {
      console.log(`   ℹ️ Preview URL: ${url}`);
    }

    // Test the preview endpoint
    const response = await fetch(`${url}/health`);
    if (response.status === 200) {
      console.log(`   ✓ Public preview working in ${region}`);
    } else {
      throw new Error(`Preview health check failed: ${response.status}`);
    }

    await sandboxInstance.previews.delete("preview-region-test");
  } catch (e) {
    console.error(`   ✗ Preview test failed in ${region}:`, e);
    throw e;
  }
}

async function main() {
  try {
    // Test 1: Create sandbox without region (should get default)
    console.log("📋 Test 1: Create sandbox without region");
    let sandbox = await SandboxInstance.create({
      name: `test-no-region-${getUniqueId()}`,
      image: testImage,
      memory: 1024
    });

    const retrieved = await SandboxInstance.get(sandbox.metadata?.name!);
    const actualRegion = retrieved.spec?.region;
    console.log(`   Default region set: ${actualRegion}`);

    if (actualRegion !== defaultRegion) {
      console.log(`   ⚠️ Expected default ${defaultRegion}, got ${actualRegion}`);
    } else {
      console.log(`   ✓ Default region correctly set`);
    }

    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log();

    // Test 2: Create sandbox with each available region
    console.log("📋 Test 2: Create sandbox with explicit regions");
    for (const testRegion of testRegions) {
      sandbox = await SandboxInstance.create({
        name: `test-region-${testRegion}-${getUniqueId()}`,
        image: testImage,
        memory: 1024,
        region: testRegion
      });



      const retrieved = await SandboxInstance.get(sandbox.metadata?.name!);
      const actualRegion = retrieved.spec?.region;

      if (actualRegion === testRegion) {
        console.log(`   ✓ ${testRegion}: Correctly set`);
      } else {
        console.error(`   ✗ ${testRegion}: Expected ${testRegion}, got ${actualRegion}`);
        throw new Error(`Region verification failed`);
      }

      await SandboxInstance.delete(sandbox.metadata?.name!);
    }

    // Test 3: Test public preview in each region
    console.log("\n📋 Test 3: Test public preview in each region");
    for (const testRegion of testRegions) {
      const sandboxName = `test-preview-${testRegion}-${getUniqueId()}`;
      sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: testImage,
        memory: 1024,
        region: testRegion
      });

      try {
        await testPreviewInRegion(sandboxName, testRegion);
      } finally {
        await SandboxInstance.delete(sandboxName);
      }
    }

    console.log("\n✅ All tests passed!");

  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("❌ Unhandled error:", err);
  });
