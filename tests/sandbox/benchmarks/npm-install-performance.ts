import { SandboxInstance, VolumeInstance } from "@blaxel/core";
import console from "console";

/**
 * Test to compare package install performance across different RAM configurations:
 * - 2GB, 4GB, and 8GB RAM
 * - All tests install on volume (persistent storage)
 * - Supports both npm and pnpm
 *
 * Each sandbox will have a volume attached and packages will be installed
 * directly on the volume to test I/O performance with different RAM sizes.
 *
 * Usage:
 *   npx tsx npm-install-performance.ts [region] [env] [package-manager]
 *
 * Arguments:
 *   region          - Optional: Sandbox region (e.g., 'eu-dub-1', 'us-east-1'). Default: undefined (uses default region)
 *   env             - Optional: Environment ('dev' or 'prod'). Default: 'prod'
 *   package-manager - Optional: Package manager ('npm', 'pnpm', or 'yarn'). Default: 'npm'
 *
 * Examples:
 *   npx tsx npm-install-performance.ts
 *   npx tsx npm-install-performance.ts eu-dub-1
 *   npx tsx npm-install-performance.ts eu-dub-1 dev
 *   npx tsx npm-install-performance.ts eu-dub-1 dev pnpm
 *   npx tsx npm-install-performance.ts eu-dub-1 dev yarn
 *   BL_ENV=dev npx tsx npm-install-performance.ts eu-dub-1 dev npm
 */

// Parse command line arguments
const args = process.argv.slice(2);
const region = args[0] && args[0] !== 'default' ? args[0] : undefined;
const env = args[1] || 'prod';
const packageManager = args[2] || 'npm'; // 'npm', 'pnpm', or 'yarn'

// Validate package manager
if (packageManager !== 'npm' && packageManager !== 'pnpm' && packageManager !== 'yarn') {
  console.error(`❌ Invalid package manager: ${packageManager}. Must be 'npm', 'pnpm', or 'yarn'`);
  process.exit(1);
}

// Set BL_ENV environment variable
if (env === 'dev' || env === 'prod') {
  process.env.BL_ENV = env;
  console.log(`🌍 Environment: ${env}`);
} else {
  console.error(`❌ Invalid environment: ${env}. Must be 'dev' or 'prod'`);
  process.exit(1);
}

if (region) {
  console.log(`📍 Region: ${region}`);
} else {
  console.log(`📍 Region: default`);
}

console.log(`📦 Package Manager: ${packageManager}`);

const packageJson = {
  "name": "performance-test",
  "version": "1.0.0",
  "dependencies": {
    "@astrojs/cloudflare": "12.6.7",
    "@astrojs/react": "4.3.0",
    "@hookform/resolvers": "5.2.1",
    "@radix-ui/react-accordion": "1.2.11",
    "@radix-ui/react-alert-dialog": "1.1.14",
    "@radix-ui/react-aspect-ratio": "1.1.7",
    "@radix-ui/react-avatar": "1.1.10",
    "@radix-ui/react-checkbox": "1.3.2",
    "@radix-ui/react-collapsible": "1.1.11",
    "@radix-ui/react-context-menu": "2.2.15",
    "@radix-ui/react-dialog": "1.1.14",
    "@radix-ui/react-dropdown-menu": "2.1.15",
    "@radix-ui/react-hover-card": "1.1.14",
    "@radix-ui/react-label": "2.1.7",
    "@radix-ui/react-menubar": "1.1.15",
    "@radix-ui/react-navigation-menu": "1.2.13",
    "@radix-ui/react-popover": "1.1.14",
    "@radix-ui/react-progress": "1.1.7",
    "@radix-ui/react-radio-group": "1.3.7",
    "@radix-ui/react-scroll-area": "1.2.9",
    "@radix-ui/react-select": "2.2.5",
    "@radix-ui/react-separator": "1.1.7",
    "@radix-ui/react-slider": "1.3.5",
    "@radix-ui/react-slot": "1.2.3",
    "@radix-ui/react-switch": "1.2.5",
    "@radix-ui/react-tabs": "1.1.12",
    "@radix-ui/react-toggle": "1.1.9",
    "@radix-ui/react-toggle-group": "1.1.10",
    "@radix-ui/react-tooltip": "1.2.7",
    "@tailwindcss/vite": "4.1.11",
    "@types/react": "19.1.9",
    "@types/react-dom": "19.1.7",
    "astro": "5.13.5",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "cmdk": "1.1.1",
    "date-fns": "4.1.0",
    "embla-carousel-react": "8.6.0",
    "input-otp": "1.4.2",
    "lucide-react": "0.533.0",
    "next-themes": "0.4.6",
    "react": "19.1.1",
    "react-day-picker": "9.8.1",
    "react-dom": "19.1.1",
    "react-hook-form": "7.61.1",
    "react-resizable-panels": "3.0.3",
    "recharts": "2.15.4",
    "sonner": "2.0.6",
    "tailwind-merge": "3.3.1",
    "tailwindcss": "4.1.11",
    "vaul": "1.1.2",
    "webflow-api": "3.2.0",
    "zod": "4.0.13"
  },
  "devDependencies": {
    "@astrojs/check": "0.9.4",
    "@cloudflare/workers-types": "4.20250726.0",
    "tw-animate-css": "1.3.6",
    "wrangler": "4.26.1"
  }
};

interface TestResult {
  configuration: string;
  memory: number;
  installPath: string;
  duration: number;
  success: boolean;
  networkSpeed?: string;
  error?: string;
  peakMemoryUsage?: string;
  diskUsage?: string;
}

/**
 * Waits for sandbox deletion to complete
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
 * Get memory and disk usage statistics
 */
async function getResourceUsage(sandbox: SandboxInstance): Promise<{ memory: string, disk: string }> {
  try {
    const memoryProc = await sandbox.process.exec({
      command: "free -h | grep Mem",
      waitForCompletion: true
    });

    const diskProc = await sandbox.process.exec({
      command: "df -h /home/user | tail -n 1",
      waitForCompletion: true
    });

    return {
      memory: memoryProc.logs?.trim() || "N/A",
      disk: diskProc.logs?.trim() || "N/A"
    };
  } catch (error) {
    return {
      memory: "Error reading memory",
      disk: "Error reading disk"
    };
  }
}

/**
 * Run npm install test on a sandbox
 */
async function runNpmInstallTest(
  sandboxName: string,
  memory: number,
  volumeName: string,
  packageMgr: string,
  region?: string
): Promise<TestResult> {
  const config = `${memory}MB RAM on Volume (${packageMgr})`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🧪 Testing: ${config}`);
  console.log(`   Sandbox: ${sandboxName}`);
  console.log(`   Memory: ${memory}MB`);
  console.log(`   Volume: ${volumeName}`);
  console.log(`   Package Manager: ${packageMgr}`);
  if (region) {
    console.log(`   Region: ${region}`);
  }
  console.log(`${"=".repeat(60)}`);

  const startTime = Date.now();
  let sandbox: SandboxInstance | null = null;
  let volume: VolumeInstance | null = null;
  let networkSpeed = "N/A";

  try {
    // Delete existing sandbox if it exists
    try {
      await SandboxInstance.delete(sandboxName);
      console.log(`🗑️  Deleted existing sandbox: ${sandboxName}`);
      await waitForSandboxDeletion(sandboxName, 30);
    } catch (error) {
      // Sandbox doesn't exist, which is fine
    }

    // Create a fresh volume for this test
    console.log("📦 Creating dedicated volume for this test...");
    try {
      await VolumeInstance.delete(volumeName);
      console.log(`🗑️  Deleted existing volume: ${volumeName}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      // Volume doesn't exist, which is fine
    }

    const volumeConfig: any = {
      name: volumeName,
      displayName: `Test Volume for ${sandboxName}`,
      size: 10240 // 10GB
    };

    if (region) {
      volumeConfig.region = region;
    }

    volume = await VolumeInstance.create(volumeConfig);
    console.log(`✅ Volume created: ${volume.name}`);

    // Create sandbox configuration - ALWAYS attach the volume
    const sandboxConfig: any = {
      name: sandboxName,
      image: "blaxel/node:latest",
      memory: memory,
      volumes: [
        {
          name: volumeName,
          mountPath: "/home/user/volume",
          readOnly: false
        }
      ]
    };

    // Add region if specified
    if (region) {
      sandboxConfig.region = region;
    }

    // Create sandbox
    console.log("📦 Creating sandbox...");
    sandbox = await SandboxInstance.create(sandboxConfig);
    console.log(`✅ Sandbox created: ${sandbox.metadata?.name}`);

    // Set ulimit for file descriptors
    console.log("⚙️  Setting ulimit -n 1000000...");
    const ulimitResult = await sandbox.process.exec({
      command: 'ulimit -n 1000000',
      waitForCompletion: true
    });
    console.log(`✅ ulimit set`);


    // All tests install on volume
    const workingDir = "/home/user/volume";
    console.log(`\n📁 Working directory: ${workingDir} (on volume)`);

    // Create project directory on volume
    console.log("📁 Creating project directory on volume...");
    await sandbox.process.exec({
      command: `mkdir -p ${workingDir}`,
      waitForCompletion: true
    });

    // Write package.json
    console.log("📝 Writing package.json...");
    const packageJsonContent = JSON.stringify(packageJson, null, 2).replace(/'/g, "'\"'\"'");
    await sandbox.process.exec({
      command: `cat > ${workingDir}/package.json << 'EOF'\n${JSON.stringify(packageJson, null, 2)}\nEOF`,
      waitForCompletion: true
    });

    // Verify package.json was written
    const verifyPackageJson = await sandbox.process.exec({
      command: `cat ${workingDir}/package.json`,
      waitForCompletion: true
    });
    console.log("✅ package.json created");

    // Get initial resource usage
    const initialUsage = await getResourceUsage(sandbox);
    console.log(`📊 Initial Memory: ${initialUsage.memory}`);
    console.log(`📊 Initial Disk: ${initialUsage.disk}`);

    // Install package manager if needed
    if (packageMgr === 'pnpm') {
      console.log("\n📦 Installing pnpm...");
      const pnpmInstall = await sandbox.process.exec({
        command: 'npm install -g pnpm',
        waitForCompletion: true
      });
      if (pnpmInstall.exitCode !== 0) {
        throw new Error(`Failed to install pnpm: ${pnpmInstall.logs}`);
      }
      console.log("✅ pnpm installed");
    }

    // Run package install and measure time
    let installCmd: string;
    if (packageMgr === 'pnpm') {
      installCmd = 'pnpm install';
    } else if (packageMgr === 'yarn') {
      installCmd = 'yarn install';
    } else {
      installCmd = 'npm install';
    }

    console.log(`\n⏱️  Starting ${installCmd}...`);
    console.log("─".repeat(60));
    const installStartTime = Date.now();

    const installProcess = await sandbox.process.exec({
      name: `${packageMgr}-install-${sandboxName}`,
      command: `cd ${workingDir} && ${installCmd}`,
      waitForCompletion: false,
      workingDir: workingDir
    });

    // Stream logs in real-time with timing updates
    let lastUpdateTime = Date.now();
    const stream = sandbox.process.streamLogs(installProcess.name!, {
      onLog: (log) => {
        console.log(`   [${packageMgr}] ${log}`);
      },
      onStdout: (stdout) => {
        // Show elapsed time every 10 seconds
        const now = Date.now();
        if (now - lastUpdateTime > 10000) {
          const elapsed = ((now - installStartTime) / 1000).toFixed(1);
          console.log(`   ⏱️  Elapsed: ${elapsed}s`);
          lastUpdateTime = now;
        }
      }
    });

    // Wait for completion with periodic progress updates
    const waitInterval = setInterval(() => {
      const elapsed = ((Date.now() - installStartTime) / 1000).toFixed(1);
      console.log(`   ⏱️  Still installing... ${elapsed}s elapsed`);
    }, 15000); // Update every 15 seconds

    try {
      await sandbox.process.wait(installProcess.name!, { maxWait: 600000, interval: 2000 }); // 10 min max
    } finally {
      clearInterval(waitInterval);
      stream.close();
    }

    const installEndTime = Date.now();
    const duration = (installEndTime - installStartTime) / 1000; // Convert to seconds

    console.log("─".repeat(60));
    console.log(`⏱️  ${installCmd} completed in ${duration.toFixed(2)}s`);

    // Check if install succeeded
    const finalProcess = await sandbox.process.get(installProcess.name!);
    if (finalProcess.status !== 'completed' || finalProcess.exitCode !== 0) {
      throw new Error(`${installCmd} failed with exit code: ${finalProcess.exitCode}`);
    }

    // Get final resource usage
    const finalUsage = await getResourceUsage(sandbox);
    console.log(`\n📊 Final Memory: ${finalUsage.memory}`);
    console.log(`📊 Final Disk: ${finalUsage.disk}`);

    // Verify node_modules was created
    const verifyNodeModules = await sandbox.process.exec({
      command: `ls -lh ${workingDir}/node_modules | head -n 20`,
      waitForCompletion: true
    });
    console.log("\n✅ node_modules created:");
    console.log(verifyNodeModules.logs?.split('\n').slice(0, 10).join('\n'));

    // Count installed packages
    const countPackages = await sandbox.process.exec({
      command: `find ${workingDir}/node_modules -maxdepth 2 -type d | wc -l`,
      waitForCompletion: true
    });
    const packageCount = countPackages.logs?.trim() || "0";
    console.log(`\n📦 Total packages/folders: ${packageCount}`);

    console.log(`\n✅ SUCCESS: ${installCmd} completed in ${duration.toFixed(2)} seconds`);

    // Print immediate summary for this test
    console.log("\n" + "═".repeat(60));
    console.log(`📊 TEST RESULT: ${config}`);
    console.log("═".repeat(60));
    console.log(`⏱️  Duration:        ${duration.toFixed(2)}s`);
    console.log(`📦 Package Manager: ${packageMgr}`);
    console.log(`🌐 Network Speed:   ${networkSpeed}`);
    console.log(`💾 Install Path:    ${workingDir}`);
    console.log(`📦 Packages:        ${packageCount}`);
    console.log(`🧠 Memory:          ${finalUsage.memory}`);
    console.log(`💿 Disk:            ${finalUsage.disk}`);
    console.log("═".repeat(60));

    return {
      configuration: config,
      memory: memory,
      installPath: workingDir,
      duration: duration,
      success: true,
      peakMemoryUsage: finalUsage.memory,
      diskUsage: finalUsage.disk
    };

  } catch (error: any) {
    const duration = (Date.now() - startTime) / 1000;
    console.error(`\n❌ FAILED: ${error.message}`);

    // Try to get logs if available
    if (sandbox) {
      try {
        const errorLogs = await sandbox.process.logs(`${packageMgr}-install-${sandboxName}`, "all");
        console.error("Error logs:", errorLogs);
      } catch {}
    }

    const workingDir = "/home/user/volume";
    return {
      configuration: config,
      memory: memory,
      installPath: workingDir,
      duration: duration,
      success: false,
      error: error.message
    };

  } finally {
    // // Cleanup sandbox
    // if (sandbox) {
    //   try {
    //     console.log(`\n🗑️  Deleting sandbox ${sandboxName}...`);
    //     await SandboxInstance.delete(sandboxName);
    //     await waitForSandboxDeletion(sandboxName);
    //   } catch (error) {
    //     console.error(`Error deleting sandbox: ${error}`);
    //   }
    // }

    // // Cleanup volume
    // if (volume) {
    //   try {
    //     console.log(`🗑️  Deleting volume ${volumeName}...`);
    //     await VolumeInstance.delete(volumeName);
    //     console.log(`✅ Volume deleted`);
    //   } catch (error) {
    //     console.error(`Error deleting volume: ${error}`);
    //   }
    // }
  }
}

/**
 * Print results table
 */
function printResults(results: TestResult[]) {
  console.log("\n\n");
  console.log("═".repeat(80));
  console.log("📊 NPM INSTALL PERFORMANCE TEST RESULTS");
  console.log("═".repeat(80));
  console.log();

  // Print table header
  console.log("┌─────────────────────────────┬──────────┬────────────┬─────────┐");
  console.log("│ Configuration               │ Memory   │ Duration   │ Status  │");
  console.log("├─────────────────────────────┼──────────┼────────────┼─────────┤");

  // Print each result
  for (const result of results) {
    const memoryStr = `${result.memory}MB`.padEnd(8);
    const durationStr = `${result.duration.toFixed(2)}s`.padEnd(10);
    const statusStr = (result.success ? "✅ Pass" : "❌ Fail").padEnd(7);
    const configStr = result.configuration.padEnd(27);

    console.log(`│ ${configStr} │ ${memoryStr} │ ${durationStr} │ ${statusStr} │`);

    if (result.error) {
      console.log(`│ Error: ${result.error.substring(0, 65).padEnd(65)} │`);
    }
  }

  console.log("└─────────────────────────────┴──────────┴────────────┴─────────┘");

  // Calculate and display comparisons
  console.log("\n📈 Performance Comparisons:");
  console.log("─".repeat(80));

  const results2gb = results.find(r => r.memory === 2048 && r.success);
  const results4gb = results.find(r => r.memory === 4096 && r.success);
  const results8gb = results.find(r => r.memory === 8192 && r.success);

  if (results2gb && results4gb) {
    const speedup = ((results2gb.duration - results4gb.duration) / results2gb.duration * 100);
    console.log(`\n🔸 RAM Impact: 2GB vs 4GB`);
    console.log(`   2GB: ${results2gb.duration.toFixed(2)}s`);
    console.log(`   4GB: ${results4gb.duration.toFixed(2)}s`);
    console.log(`   → 4GB is ${Math.abs(speedup).toFixed(1)}% ${speedup > 0 ? 'faster' : 'slower'} than 2GB`);
  }

  if (results4gb && results8gb) {
    const speedup = ((results4gb.duration - results8gb.duration) / results4gb.duration * 100);
    console.log(`\n🔸 RAM Impact: 4GB vs 8GB`);
    console.log(`   4GB: ${results4gb.duration.toFixed(2)}s`);
    console.log(`   8GB: ${results8gb.duration.toFixed(2)}s`);
    console.log(`   → 8GB is ${Math.abs(speedup).toFixed(1)}% ${speedup > 0 ? 'faster' : 'slower'} than 4GB`);
  }

  if (results2gb && results8gb) {
    const speedup = ((results2gb.duration - results8gb.duration) / results2gb.duration * 100);
    console.log(`\n🔸 RAM Impact: 2GB vs 8GB`);
    console.log(`   2GB: ${results2gb.duration.toFixed(2)}s`);
    console.log(`   8GB: ${results8gb.duration.toFixed(2)}s`);
    console.log(`   → 8GB is ${Math.abs(speedup).toFixed(1)}% ${speedup > 0 ? 'faster' : 'slower'} than 2GB`);
  }

  // Find fastest configuration
  const successfulResults = results.filter(r => r.success);
  if (successfulResults.length > 0) {
    const fastest = successfulResults.reduce((prev, current) =>
      current.duration < prev.duration ? current : prev
    );
    console.log(`\n🏆 Fastest Configuration: ${fastest.configuration} (${fastest.duration.toFixed(2)}s)`);
  }

  console.log("\n" + "═".repeat(80));
}

async function main() {
  const results: TestResult[] = [];

  try {
    console.log("\n🚀 NPM Install Performance Test");
    console.log("Testing npm install on volume with different RAM configurations");
    console.log();
    console.log("Each test creates a fresh dedicated volume.");
    console.log("Testing RAM sizes: 8GB, 4GB, and 2GB (in that order)");
    console.log();

    // Use package manager name in sandbox/volume names to avoid conflicts
    let prefix: string;
    if (packageManager === 'pnpm') {
      prefix = 'pnpm-perf';
    } else if (packageManager === 'yarn') {
      prefix = 'yarn-perf';
    } else {
      prefix = 'npm-perf';
    }

    // Test 1: 8GB RAM on Volume
    console.log("\n🔹 TEST 1/3: 8GB RAM on Volume");
    const result1 = await runNpmInstallTest(
      `${prefix}-8gb-volume` + '-' + Math.random().toString(36).substring(2, 8),
      8192,
      `${prefix}-8gb-volume` + '-' + Math.random().toString(36).substring(2, 8),
      packageManager,
      region
    );
    results.push(result1);

    // // Test 2: 4GB RAM on Volume
    // console.log("\n🔹 TEST 2/3: 4GB RAM on Volume");
    // const result2 = await runNpmInstallTest(
    //   `${prefix}-4gb-volume`,
    //   4096,
    //   `${prefix}-4gb-volume`,
    //   packageManager,
    //   region
    // );
    // results.push(result2);

    // // Test 3: 2GB RAM on Volume
    // console.log("\n🔹 TEST 3/3: 2GB RAM on Volume");
    // const result3 = await runNpmInstallTest(
    //   `${prefix}-2gb-volume`,
    //   2048,
    //   `${prefix}-2gb-volume`,
    //   packageManager,
    //   region
    // );
    // results.push(result3);

    // Print final results
    printResults(results);

    console.log("\n✨ All tests completed!");

  } catch (error: any) {
    console.error("❌ Test suite failed with error:", error);
    console.error(error.stack);
    process.exit(1);
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

