import { SandboxInstance, VolumeInstance, VolumeCreateConfiguration } from "@blaxel/core";
import console from "console";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

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

try {
  console.log("📦 Volume Template Test");
  console.log("=".repeat(60));

  // Choose image based on BL_ENV
  const isDev = process.env.BL_ENV === 'dev';
  const imageBase = isDev ? 'dev-base' : 'prod-base';
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

  // Step 2: Add files to the template (create Next.js app)
  console.log("\n2. Adding files to template...");
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

  // Step 3: Deploy the volume template (version 1)
  console.log("\n3. Deploying volume template (version 1)...");
  const { stdout: deployStdout1, stderr: deployStderr1 } = await execAsync(
    `bl deploy`,
    { cwd: templatePath }
  );
  console.log(deployStdout1);
  if (deployStderr1) console.error(deployStderr1);
  console.log("✅ Volume template deployed (version 1)");

  // Step 4: Create a volume from the template
  console.log("\n4. Creating volume from template...");
  const volume1 = await VolumeInstance.create({
    name: "test-template-volume-1",
    displayName: "Test Template Volume 1",
    size: 1024,
    template: templateName
  } as VolumeCreateConfiguration);
  console.log(`✅ Volume created: ${volume1.name} with template: ${templateName}`);

  // Step 5: Create a sandbox with that volume
  console.log("\n5. Creating sandbox with volume...");
  const sandbox1 = await SandboxInstance.create({
    name: "template-sandbox-1",
    image: image,
    memory: 2048,
    volumes: [
      {
        name: "test-template-volume-1",
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

  // Check for key Next.js files
  const checkNextFiles = await sandbox1.process.exec({
    command: "test -f /app/package.json && test -f /app/next.config.ts && echo 'Next.js files found' || echo 'Next.js files missing'",
    waitForCompletion: true
  });
  console.log(`✅ ${checkNextFiles.logs?.trim()}`);

  // Clean up sandbox and volume
  await cleanupSandboxAndVolume("template-sandbox-1", "test-template-volume-1");

  // Step 7: Add a new file to the template
  console.log("\n7. Adding a new file to the template...");
  const testFilePath = path.join(templatePath, testFileName);
  fs.writeFileSync(testFilePath, testFileContent);
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

  // Step 9: Create a new volume from the latest template
  console.log("\n9. Creating volume from latest template (version 2)...");
  const volume2 = await VolumeInstance.create({
    name: "test-template-volume-2",
    displayName: "Test Template Volume 2",
    size: 1024,
    template: templateName
  } as VolumeCreateConfiguration);
  console.log(`✅ Volume created: ${volume2.name}`);

  // Step 10: Create a sandbox with the new volume
  console.log("\n10. Creating sandbox with new volume...");
  const sandbox2 = await SandboxInstance.create({
    name: "template-sandbox-2",
    image: image,
    memory: 2048,
    volumes: [
      {
        name: "test-template-volume-2",
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
  await cleanupSandboxAndVolume("template-sandbox-2", "test-template-volume-2");

  // Step 12: Create a volume from version 1 (should not have the new file)
  console.log("\n12. Creating volume from template version 1...");
  const volume3 = await VolumeInstance.create({
    name: "test-template-volume-3",
    displayName: "Test Template Volume 3 (version 1)",
    size: 1024,
    template: `${templateName}:1`
  } as VolumeCreateConfiguration);
  console.log(`✅ Volume created: ${volume3.name} with template: ${templateName}:1`);

  // Step 13: Create a sandbox with version 1 volume
  console.log("\n13. Creating sandbox with version 1 volume...");
  const sandbox3 = await SandboxInstance.create({
    name: "template-sandbox-3",
    image: image,
    memory: 2048,
    volumes: [
      {
        name: "test-template-volume-3",
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
  await cleanupSandboxAndVolume("template-sandbox-3", "test-template-volume-3");

  console.log("\n🎉 SUCCESS: All volume template tests passed!");
  console.log("   ✓ Template creation and deployment");
  console.log("   ✓ Volume creation from template");
  console.log("   ✓ File verification in sandboxes");
  console.log("   ✓ Version 2 contains new file");
  console.log("   ✓ Version 1 does not contain new file");

} catch (e: any) {
  console.error("❌ Test failed with error:", e);
  process.exit(1);
} finally {
  // Final cleanup
  console.log("\n🧹 Final cleanup...");

  // Clean up any remaining sandboxes and volumes
  const cleanupItems = [
    { sandbox: "template-sandbox-1", volume: "test-template-volume-1" },
    { sandbox: "template-sandbox-2", volume: "test-template-volume-2" },
    { sandbox: "template-sandbox-3", volume: "test-template-volume-3" },
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
}

