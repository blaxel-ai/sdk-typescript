import { SandboxInstance, VolumeInstance } from "@blaxel/core";
import console from "console";

/**
 * Test volume templates with preinstalled node_modules
 *
 * This script:
 * 1. Creates a volume from the template "mytemplate"
 * 2. Creates a sandbox and mounts the volume
 * 3. Runs the index.js file from the template with node
 * 4. Cleans up sandbox and volume
 *
 * Usage:
 *   npx tsx volume-template-test.ts [template-name] [region] [env]
 *
 * Arguments:
 *   template-name - Optional: Volume template name. Default: 'mytemplate'
 *   region        - Optional: Sandbox region (e.g., 'eu-dub-1', 'us-east-1'). Default: undefined
 *   env           - Optional: Environment ('dev' or 'prod'). Default: 'prod'
 *
 * Examples:
 *   npx tsx volume-template-test.ts
 *   npx tsx volume-template-test.ts mytemplate
 *   npx tsx volume-template-test.ts mytemplate eu-dub-1
 *   npx tsx volume-template-test.ts mytemplate eu-dub-1 dev
 */

// Parse command line arguments
const args = process.argv.slice(2);
const templateName = args[0] || 'mytemplate';
const region = args[1] && args[1] !== 'default' ? args[1] : undefined;
const env = args[2] || 'prod';

// Set BL_ENV environment variable
if (env === 'dev' || env === 'prod') {
  process.env.BL_ENV = env;
  console.log(`🌍 Environment: ${env}`);
} else {
  console.error(`❌ Invalid environment: ${env}. Must be 'dev' or 'prod'`);
  process.exit(1);
}

console.log(`📦 Template: ${templateName}`);

if (region) {
  console.log(`📍 Region: ${region}`);
} else {
  console.log(`📍 Region: default`);
}

/**
 * Wait for sandbox deletion to complete
 */
async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  console.log(`⏳ Waiting for ${sandboxName} deletion to fully complete...`);
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (error) {
      console.log(`✅ ${sandboxName} fully deleted`);
      return true;
    }
  }

  console.log(`⚠️ Timeout waiting for ${sandboxName} deletion`);
  return false;
}

/**
 * Wait for volume deletion to complete
 */
async function waitForVolumeDeletion(volumeName: string, maxAttempts: number = 30): Promise<boolean> {
  console.log(`⏳ Waiting for ${volumeName} deletion to fully complete...`);
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      await VolumeInstance.get(volumeName);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (error) {
      console.log(`✅ ${volumeName} fully deleted`);
      return true;
    }
  }

  console.log(`⚠️ Timeout waiting for ${volumeName} deletion`);
  return false;
}

async function main() {
  const timestamp = Math.random().toString(36).substring(2, 8);
  const volumeName = `vol-from-template-${timestamp}`;
  const sandboxName = `sandbox-template-test-${timestamp}`;

  let sandbox: SandboxInstance | null = null;
  let volume: VolumeInstance | null = null;

  try {
    console.log("\n" + "═".repeat(70));
    console.log("🧪 Volume Template Test - Running index.js from template");
    console.log("═".repeat(70));

    // Step 1: Create a volume from the template
    console.log(`\n📦 Step 1: Creating volume from template '${templateName}'...`);
    const volumeConfig: any = {
      name: volumeName,
      displayName: `Volume from ${templateName}`,
      template: templateName
    };

    if (region) {
      volumeConfig.region = region;
    }

    volume = await VolumeInstance.create(volumeConfig);
    console.log(`✅ Volume created from template: ${volume.name}`);

    // Step 2: Create sandbox with the volume
    console.log("\n📦 Step 2: Creating sandbox with volume...");
    const sandboxConfig: any = {
      name: sandboxName,
      image: "blaxel/node:latest",
      memory: 2048,
      volumes: [
        {
          name: volumeName,
          mountPath: "/home/user/app",
          readOnly: false
        }
      ]
    };

    if (region) {
      sandboxConfig.region = region;
    }

    sandbox = await SandboxInstance.create(sandboxConfig);
    console.log(`✅ Sandbox created: ${sandbox.metadata?.name}`);

    // Step 3: List volume contents
    console.log("\n📂 Step 3: Checking volume contents...");
    const listFiles = await sandbox.process.exec({
      command: 'ls -lah /home/user/app',
      waitForCompletion: true
    });
    console.log(listFiles.logs || "No files");

    // Step 4: Check if index.js exists
    console.log("\n🔍 Step 4: Verifying index.js exists...");
    const checkIndexJs = await sandbox.process.exec({
      command: 'test -f /home/user/app/index.js && echo "✅ index.js found" || echo "❌ index.js not found"',
      waitForCompletion: true
    });
    console.log(checkIndexJs.logs);

    if (checkIndexJs.logs?.includes('not found')) {
      throw new Error('index.js not found in the volume template');
    }

    // Step 5: Check if node_modules exists
    console.log("\n🔍 Step 5: Checking for node_modules...");
    const checkNodeModules = await sandbox.process.exec({
      command: 'test -d /home/user/app/node_modules && echo "✅ node_modules found" || echo "⚠️  node_modules not found"',
      waitForCompletion: true
    });
    console.log(checkNodeModules.logs);

    // Step 6: Run initial npm install (if package.json exists)
    console.log("\n📦 Step 6: Running initial npm install...");
    console.log("─".repeat(70));

    const initialInstallProcess = await sandbox.process.exec({
      name: `npm-install-initial-${sandboxName}`,
      command: 'cd /home/user/app && npm install',
      waitForCompletion: false
    });

    // Stream installation logs
    const initialStream = sandbox.process.streamLogs(initialInstallProcess.name!, {
      onLog: (log) => {
        console.log(`   [npm] ${log}`);
      }
    });

    // Wait for installation to complete
    await sandbox.process.wait(initialInstallProcess.name!, { maxWait: 300000, interval: 2000 });
    initialStream.close();

    // Check if initial install succeeded
    const initialResult = await sandbox.process.get(initialInstallProcess.name!);
    if (initialResult.exitCode === 0) {
      console.log("─".repeat(70));
      console.log(`✅ Initial npm install completed`);
    } else {
      console.log("─".repeat(70));
      console.log(`⚠️  Initial npm install had issues (exit code: ${initialResult.exitCode}), continuing anyway...`);
    }

    // Step 7: Install react-big-calendar and time it
    console.log("\n📦 Step 7: Installing react-big-calendar (timed)...");
    console.log("─".repeat(70));
    const installStartTime = Date.now();

    const installProcess = await sandbox.process.exec({
      name: `npm-install-rbc-${sandboxName}`,
      command: 'cd /home/user/app && npm install react-big-calendar',
      waitForCompletion: false
    });

    // Stream installation logs
    const installStream = sandbox.process.streamLogs(installProcess.name!, {
      onLog: (log) => {
        console.log(`   [npm] ${log}`);
      }
    });

    // Wait for installation to complete
    await sandbox.process.wait(installProcess.name!, { maxWait: 300000, interval: 2000 });
    installStream.close();

    const installEndTime = Date.now();
    const installDuration = ((installEndTime - installStartTime) / 1000).toFixed(2);

    // Check if install succeeded
    const installResult = await sandbox.process.get(installProcess.name!);
    if (installResult.exitCode === 0) {
      console.log("─".repeat(70));
      console.log(`✅ react-big-calendar installed successfully in ${installDuration}s`);
    } else {
      console.log("─".repeat(70));
      console.log(`❌ Failed to install react-big-calendar (exit code: ${installResult.exitCode})`);
      throw new Error(`npm install react-big-calendar failed with exit code: ${installResult.exitCode}`);
    }

    // Verify the package was installed
    console.log("\n🔍 Verifying react-big-calendar installation...");
    const verifyInstall = await sandbox.process.exec({
      command: 'test -d /home/user/app/node_modules/react-big-calendar && echo "✅ react-big-calendar found in node_modules" || echo "❌ react-big-calendar not found"',
      waitForCompletion: true
    });
    console.log(verifyInstall.logs);

    // Step 8: Run index.js
    console.log("\n🚀 Step 8: Running index.js with node...");
    console.log("─".repeat(70));

    const runProcess = await sandbox.process.exec({
      name: `run-index-${sandboxName}`,
      command: 'cd /home/user/app && node index.js',
      waitForCompletion: true
    });

    console.log("\n📄 Output from index.js:");
    console.log(runProcess.logs || "No output");
    console.log("─".repeat(70));

    if (runProcess.exitCode === 0) {
      console.log("\n✅ SUCCESS: index.js executed successfully!");
    } else {
      console.log(`\n❌ FAILED: index.js exited with code ${runProcess.exitCode}`);

      // Try to get error details
      console.log("\n🔍 Checking for errors...");
      const errorCheck = await sandbox.process.exec({
        command: 'cd /home/user/app && node index.js 2>&1',
        waitForCompletion: true
      });
      console.log("Error output:");
      console.log(errorCheck.logs);

      throw new Error(`Execution failed with exit code: ${runProcess.exitCode}`);
    }

    console.log("\n" + "═".repeat(70));
    console.log("🎉 Volume Template Test PASSED!");
    console.log("═".repeat(70));
    console.log(`✅ Template: ${templateName}`);
    console.log(`✅ Volume: ${volumeName}`);
    console.log(`✅ Sandbox: ${sandboxName}`);
    console.log(`✅ react-big-calendar installed in ${installDuration}s`);
    console.log(`✅ index.js executed successfully from template`);
    console.log("═".repeat(70));

  } catch (error: any) {
    console.error("\n❌ Test failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Cleanup
    console.log("\n🧹 Cleanup: Deleting resources...");

    if (sandbox) {
      try {
        console.log(`🗑️  Deleting sandbox ${sandboxName}...`);
        await SandboxInstance.delete(sandboxName);
        await waitForSandboxDeletion(sandboxName);
      } catch (error) {
        console.error(`Error deleting sandbox: ${error}`);
      }
    }

    if (volume) {
      try {
        console.log(`🗑️  Deleting volume ${volumeName}...`);
        await VolumeInstance.delete(volumeName);
        await waitForVolumeDeletion(volumeName);
      } catch (error) {
        console.error(`Error deleting volume: ${error}`);
      }
    }

    console.log("✅ Cleanup complete");
  }
}

main()
  .catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });

