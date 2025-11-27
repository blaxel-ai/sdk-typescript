import { SandboxInstance, VolumeCreateConfiguration, VolumeInstance } from "@blaxel/core";
import { exec } from "child_process";
import console from "console";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Waits for a sandbox deletion to fully complete by polling until the sandbox no longer exists
 */
async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  console.log(`⏳ Waiting for ${sandboxName} deletion to fully complete...`);
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      console.log(`   Still exists, waiting... (${attempts}/${maxAttempts})`);
    } catch (error) {
      console.log(`✅ ${sandboxName} fully deleted`);
      return true;
    }
  }

  console.log(`⚠️ Timeout waiting for ${sandboxName} deletion to complete`);
  return false;
}

/**
 * Cleans up sandbox and volume
 */
async function cleanupSandboxAndVolume(sandboxName: string, volumeName: string) {
  try {
    console.log(`\n🧹 Cleaning up ${sandboxName}...`);
    await SandboxInstance.delete(sandboxName);
    const deletionCompleted = await waitForSandboxDeletion(sandboxName);
    if (!deletionCompleted) {
      console.warn(`⚠️ Timeout waiting for ${sandboxName} deletion`);
    }
  } catch (e: any) {
    console.log(`⚠️ Could not delete sandbox ${sandboxName}: ${e.message}`);
  }

  try {
    console.log(`🧹 Cleaning up ${volumeName}...`);
    await VolumeInstance.delete(volumeName);
    console.log(`✅ Volume ${volumeName} deleted`);
  } catch (e: any) {
    console.log(`⚠️ Could not delete volume ${volumeName}: ${e.message}`);
  }
}

const templateName = "test-volume-template";
const templatePath = path.join(process.cwd(), templateName);
const testFileName = "test-persistence.txt";
const testFileContent = "This file was added after initial deploy";

// Use SIMPLE_TEMPLATE=true to create a simple text-based template instead of Next.js
const useSimpleTemplate = process.env.SIMPLE_TEMPLATE === 'true';

// Use NO_CLEANUP=true to skip cleanup of sandboxes, volumes, and templates (useful for debugging)
const noCleanup = process.env.NO_CLEANUP === 'true';

const volumeName1 = `test-template-vol-1`;
const sandboxName1 = `template-sb-1`;
const volumeName2 = `test-template-vol-2`;
const sandboxName2 = `template-sb-2`;
const volumeName3 = `test-template-vol-3`;
const sandboxName3 = `template-sb-3`;

try {
  console.log("📦 Volume Template Test");
  console.log("=".repeat(60));
  console.log(`Template type: ${useSimpleTemplate ? 'Simple (text files)' : 'Next.js app'}`);
  console.log(`Cleanup: ${noCleanup ? 'DISABLED (resources will persist)' : 'ENABLED'}`);

  // Choose image based on BL_ENV
  const imageBase = 'base';
  const image = `blaxel/${imageBase}:latest`;
  console.log(`Using image: ${image} (BL_ENV=${process.env.BL_ENV || 'not set'})`);

  // Step 1: Create volume template if folder doesn't exist
  console.log("\n1. Creating volume template folder...");
  if (!fs.existsSync(templatePath)) {
    console.log(`   Creating template: ${templateName}`);
    const { stdout, stderr } = await execAsync(`bl new vt ${templateName} -y`);
    console.log(stdout);
    if (stderr) console.error(stderr);
    console.log(`✅ Template folder created: ${templateName}`);
  } else {
    console.log(`✅ Template folder already exists: ${templateName}`);
  }

  // Step 2: Add files to the template
  console.log("\n2. Adding files to template...");

  if (useSimpleTemplate) {
    // Create simple text-based template
    const markerFile = path.join(templatePath, "app.txt");
    if (!fs.existsSync(markerFile)) {
      console.log("   Creating simple text files in template...");

      // Create a few simple files
      fs.writeFileSync(path.join(templatePath, "app.txt"), "This is the main app file");
      fs.writeFileSync(path.join(templatePath, "config.json"), JSON.stringify({
        name: "test-app",
        version: "1.0.0",
        description: "Simple template for volume testing"
      }, null, 2));
      fs.writeFileSync(path.join(templatePath, "next.config.ts"), "// Next.js config file");

      // Create a subdirectory with files
      const dataDir = path.join(templatePath, "data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
      }
      fs.writeFileSync(path.join(dataDir, "sample.txt"), "Sample data file");
      fs.writeFileSync(path.join(dataDir, "info.txt"), "Information file");

      console.log("✅ Simple template files created");
    } else {
      console.log("✅ Template already contains app.txt");
    }
  } else {
    // Create Next.js app template
    const packageJsonPath = path.join(templatePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      console.log("   Creating Next.js app in template...");

      // Create Next.js app in a temporary directory
      const tempAppName = `temp-nextjs-${Date.now()}`;
      const tempAppPath = path.join(process.cwd(), tempAppName);

      try {
        const { stdout, stderr } = await execAsync(
          `npx create-next-app@latest ${tempAppName} --ts --tailwind --eslint --skip-install --app --no-src-dir --import-alias "@/*" --yes`,
          { cwd: process.cwd() }
        );
        console.log(stdout);
        if (stderr && !stderr.includes("npm notice")) console.error(stderr);

        // Copy all files from temp directory to template directory (excluding node_modules, will install fresh)
        console.log("   Copying Next.js files to template...");
        const files = fs.readdirSync(tempAppPath);
        for (const file of files) {
          if (file === 'node_modules') continue; // Skip node_modules, will install fresh

          const srcPath = path.join(tempAppPath, file);
          const destPath = path.join(templatePath, file);

          // Copy file or directory
          if (fs.statSync(srcPath).isDirectory()) {
            fs.cpSync(srcPath, destPath, { recursive: true });
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }

        // Clean up temp directory
        fs.rmSync(tempAppPath, { recursive: true, force: true });

        // Install dependencies in the template directory
        console.log("   Installing dependencies in template...");
        const { stdout: installStdout, stderr: installStderr } = await execAsync(
          'npm install',
          { cwd: templatePath }
        );
        console.log(installStdout);
        if (installStderr && !installStderr.includes("npm warn")) console.error(installStderr);

        console.log("✅ Next.js app created in template with dependencies installed");
      } catch (error) {
        // Clean up temp directory on error
        if (fs.existsSync(tempAppPath)) {
          fs.rmSync(tempAppPath, { recursive: true, force: true });
        }
        throw error;
      }
    } else {
      console.log("✅ Template already contains package.json");
    }
  }

  // Step 3: Deploy the volume template (version 1)
  console.log("\n3. Deploying volume template (version 1)...");

  // Remove test file if it exists from previous run
  const testFileFullPath = path.join(templatePath, testFileName);
  if (fs.existsSync(testFileFullPath)) {
    console.log(`   Removing existing ${testFileName} from previous run...`);
    fs.unlinkSync(testFileFullPath);
  }

  const { stdout: deployStdout1, stderr: deployStderr1 } = await execAsync(
    `bl deploy`,
    { cwd: templatePath }
  );
  console.log(deployStdout1);
  if (deployStderr1) console.error(deployStderr1);
  console.log("✅ Volume template deployed (version 1)");

  // Wait for template to be fully processed
  console.log("⏳ Waiting for template to be processed...");
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Step 4: Create a volume from the template
  console.log("\n4. Creating volume from template...");
  const volume1 = await VolumeInstance.createIfNotExists({
    name: volumeName1,
    displayName: "Test Template Volume 1",
    size: 1024,
    template: templateName
  } as VolumeCreateConfiguration);
  console.log(`✅ Volume created: ${volume1.name} with template: ${templateName}`);

  // Step 5: Create a sandbox with that volume
  console.log("\n5. Creating sandbox with volume...");
  const sandbox1 = await SandboxInstance.createIfNotExists({
    name: sandboxName1,
    image: image,
    memory: 2048,
    volumes: [
      {
        name: volumeName1,
        mountPath: "/app",
        readOnly: false
      }
    ]
  });
  console.log(`✅ Sandbox created: ${sandbox1.metadata?.name}`);

  // Step 6: Verify files exist in the volume
  console.log("\n6. Verifying files from template in sandbox...");
  const lsResult1 = await sandbox1.process.exec({
    command: "ls -la /app/",
    waitForCompletion: true
  });
  console.log(`📁 Files in /app/:\n${lsResult1.logs?.trim()}`);

  // Check for next.config.ts file (required for both simple and Next.js templates)
  const checkConfigFile = await sandbox1.process.exec({
    command: "test -f /app/next.config.ts && echo 'found' || echo 'missing'",
    waitForCompletion: true
  });
  const configFileExists = checkConfigFile.logs?.trim() === 'found';

  if (!configFileExists) {
    throw new Error("❌ next.config.ts file not found in template volume!");
  }
  console.log("✅ next.config.ts file found in template");

  // Check for additional files based on template type
  if (!useSimpleTemplate) {
    const checkPackageJson = await sandbox1.process.exec({
      command: "test -f /app/package.json && echo 'found' || echo 'missing'",
      waitForCompletion: true
    });
    if (checkPackageJson.logs?.trim() !== 'found') {
      throw new Error("❌ package.json file not found in Next.js template!");
    }
    console.log("✅ package.json file found in Next.js template");
  } else {
    const checkAppTxt = await sandbox1.process.exec({
      command: "test -f /app/app.txt && echo 'found' || echo 'missing'",
      waitForCompletion: true
    });
    if (checkAppTxt.logs?.trim() !== 'found') {
      throw new Error("❌ app.txt file not found in simple template!");
    }
    console.log("✅ app.txt file found in simple template");
  }

  // Clean up sandbox and volume
  if (!noCleanup) {
    await cleanupSandboxAndVolume(sandboxName1, volumeName1);
  } else {
    console.log(`⏭️  Skipping cleanup for ${sandboxName1} and ${volumeName1}`);
  }

  // Step 7: Add a new file to the template
  console.log("\n7. Adding a new file to the template...");
  fs.writeFileSync(testFileFullPath, testFileContent);
  console.log(`✅ File created: ${testFileName}`);

  // Step 8: Deploy the template again (version 2)
  console.log("\n8. Deploying volume template (version 2)...");
  const { stdout: deployStdout2, stderr: deployStderr2 } = await execAsync(
    `bl deploy`,
    { cwd: templatePath }
  );
  console.log(deployStdout2);
  if (deployStderr2) console.error(deployStderr2);
  console.log("✅ Volume template deployed (version 2)");

  // Wait for template to be fully processed
  console.log("⏳ Waiting for template to be processed...");
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Step 9: Create a new volume from the latest template
  console.log("\n9. Creating volume from latest template (version 2)...");
  const volume2 = await VolumeInstance.createIfNotExists({
    name: volumeName2,
    displayName: "Test Template Volume 2",
    size: 1024,
    template: templateName
  } as VolumeCreateConfiguration);
  console.log(`✅ Volume created: ${volume2.name}`);

  // Step 10: Create a sandbox with the new volume
  console.log("\n10. Creating sandbox with new volume...");
  const sandbox2 = await SandboxInstance.createIfNotExists({
    name: sandboxName2,
    image: image,
    memory: 2048,
    volumes: [
      {
        name: volumeName2,
        mountPath: "/app",
        readOnly: false
      }
    ]
  });
  console.log(`✅ Sandbox created: ${sandbox2.metadata?.name}`);

  // Step 11: Verify the new file exists
  console.log("\n11. Verifying new file exists in sandbox...");
  const checkNewFile = await sandbox2.process.exec({
    command: `test -f /app/${testFileName} && echo 'New file found' || echo 'New file missing'`,
    waitForCompletion: true
  });
  console.log(`   ${checkNewFile.logs?.trim()}`);

  const readNewFile = await sandbox2.process.exec({
    command: `cat /app/${testFileName}`,
    waitForCompletion: true
  });
  const readContent = readNewFile.logs?.trim();
  console.log(`   File content: "${readContent}"`);

  if (readContent === testFileContent) {
    console.log("✅ New file content matches - version 2 deployed correctly!");
  } else {
    throw new Error(`File content mismatch. Expected: "${testFileContent}", Got: "${readContent}"`);
  }

  // Clean up sandbox and volume
  if (!noCleanup) {
    await cleanupSandboxAndVolume(sandboxName2, volumeName2);
  } else {
    console.log(`⏭️  Skipping cleanup for ${sandboxName2} and ${volumeName2}`);
  }

  // Step 12: Create a volume from version 1 (should not have the new file)
  console.log("\n12. Creating volume from template version 1...");
  const volume3 = await VolumeInstance.createIfNotExists({
    name: volumeName3,
    displayName: "Test Template Volume 3 (version 1)",
    size: 1024,
    template: `${templateName}:1`
  } as VolumeCreateConfiguration);
  console.log(`✅ Volume created: ${volume3.name} with template: ${templateName}:1`);

  // Step 13: Create a sandbox with version 1 volume
  console.log("\n13. Creating sandbox with version 1 volume...");
  const sandbox3 = await SandboxInstance.createIfNotExists({
    name: sandboxName3,
    image: image,
    memory: 2048,
    volumes: [
      {
        name: volumeName3,
        mountPath: "/app",
        readOnly: false
      }
    ]
  });
  console.log(`✅ Sandbox created: ${sandbox3.metadata?.name}`);

  // Step 14: Verify the new file does NOT exist in version 1
  console.log("\n14. Verifying new file does NOT exist in version 1...");
  const checkFileV1 = await sandbox3.process.exec({
    command: `test -f /app/${testFileName} && echo 'File found (unexpected)' || echo 'File not found (expected)'`,
    waitForCompletion: true
  });
  const v1Result = checkFileV1.logs?.trim();
  console.log(`   ${v1Result}`);

  if (v1Result === "File not found (expected)") {
    console.log("✅ Version 1 correctly does not contain the new file!");
  } else {
    throw new Error("Version 1 should not contain the new file, but it was found");
  }

  // Clean up sandbox and volume
  if (!noCleanup) {
    await cleanupSandboxAndVolume(sandboxName3, volumeName3);
  } else {
    console.log(`⏭️  Skipping cleanup for ${sandboxName3} and ${volumeName3}`);
  }

  console.log("\n🎉 SUCCESS: All volume template tests passed!");
  console.log("   ✓ Template creation and deployment");
  console.log("   ✓ Volume creation from template");
  console.log("   ✓ File verification in sandboxes");
  console.log("   ✓ Version 2 contains new file");
  console.log("   ✓ Version 1 does not contain new file");

} catch (e: any) {
  console.error("\n❌ Test failed with error:", e);
} finally {
  if (noCleanup) {
    console.log("\n⏭️  Cleanup DISABLED - Resources will persist:");
    console.log(`   Sandboxes: ${sandboxName1}, ${sandboxName2}, ${sandboxName3}`);
    console.log(`   Volumes: ${volumeName1}, ${volumeName2}, ${volumeName3}`);
    console.log(`   Template: ${templateName}`);
  } else {
    // Final cleanup - runs even on error
    console.log("\n🧹 Final cleanup (running even if test failed)...");

    // Clean up any remaining sandboxes and volumes
    const cleanupItems = [
      { sandbox: sandboxName1, volume: volumeName1 },
      { sandbox: sandboxName2, volume: volumeName2 },
      { sandbox: sandboxName3, volume: volumeName3 },
    ];

    for (const item of cleanupItems) {
      try {
        await SandboxInstance.delete(item.sandbox);
        await waitForSandboxDeletion(item.sandbox);
      } catch (e) {
        // Ignore errors during cleanup
      }
      try {
        await VolumeInstance.delete(item.volume);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }

    // Delete the volume template
    try {
      console.log("\n🗑️  Deleting volume template...");
      const { stdout, stderr } = await execAsync(`bl delete vt ${templateName}`);
      console.log(stdout);
      if (stderr) console.error(stderr);
      console.log("✅ Volume template deleted");
    } catch (e: any) {
      console.error(`❌ Could not delete volume template: ${e.message}`);
    }

    // Delete the template folder
    try {
      if (fs.existsSync(templatePath)) {
        console.log(`\n🗑️  Deleting template folder: ${templateName}`);
        fs.rmSync(templatePath, { recursive: true, force: true });
        console.log("✅ Template folder deleted");
      }
    } catch (e: any) {
      console.error(`❌ Could not delete template folder: ${e.message}`);
    }
  }

  console.log("\n✨ Cleanup complete");
}

