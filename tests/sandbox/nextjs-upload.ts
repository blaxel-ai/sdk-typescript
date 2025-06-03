import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from 'uuid';
import { checkUsage, createOrGetSandbox, createPreview, createZipFromDirectory, runCommand, sep } from "../utils";

const sandboxName = uuidv4().toString().slice(0, 32)

async function main() {

  try {
    // Test with controlplane
    console.log(sep)
    console.log('Starting sandbox test')
    console.log(sep)
    const sandbox = await createOrGetSandbox({
      sandboxName,
      image: 'prod/main/node-custom:latest',
      memory: 8192,
      ports: [
        { name: 'sandbox-api', target: 8080, protocol: 'HTTP' },
        { name: 'nextjs', target: 3000, protocol: 'HTTP' }
      ],
      envs: [
        { name: 'BL_API_KEY', value: process.env.BL_API_KEY! },
        { name: 'BL_WORKSPACE', value: process.env.BL_WORKSPACE! }
      ]
    })

    // Create zip file from nextjs-sandbox-test directory
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const sourceDir = path.join(currentDir, 'nextjs-sandbox-test');
    const zipPath = path.join(currentDir, 'archive.zip');
    console.log(sep)
    console.log(`📁 Creating zip file from ${sourceDir} to ${zipPath}`)
    fs.rmSync(zipPath, { force: true })
    createZipFromDirectory(sourceDir, zipPath);
    console.log(`📦 Zip file created successfully: ${zipPath}`)
    console.log(sep)

    console.log('🚀 Uploading zip file to sandbox')
    const zipBuffer = fs.readFileSync(zipPath)
    await sandbox.fs.writeBinary('/home/user/archive.zip', zipBuffer)
    await runCommand(sandbox, {name: 'extract', command: 'unzip -o archive.zip -x "__MACOSX/*" "*.DS_Store"', workingDir: '/home/user'})
    console.log("✅ Zip file uploaded and extracted successfully")

    // Check available disk space and memory
    await checkUsage(sandbox)

    // Try pnpm install with more verbose output and error handling
    console.log(sep)
    console.log("💽 Start npm install")
    console.log(sep)
    await runCommand(sandbox, {name: 'npm', command: 'npm install', workingDir: '/home/user/nextjs-sandbox-test', waitForCompletion: false, maxWait: 15 * 60 * 1000})
    console.log("✅ npm install completed")
    console.log(sep)

    // Check available disk space and memory
    await checkUsage(sandbox)

    // Creating preview
    console.log(sep)
    console.log("🤖 Creating preview")
    console.log(sep)
    const preview = await createPreview(sandbox)
    console.log(`🎉 Preview created successfully!`)
    console.log(`📝 Name: ${preview.name}`)
    console.log(`🌐 URL: ${preview.spec?.url}`)
    console.log(sep)

    console.log(`🚀 Your app is now accessible via the preview URL!\n`)
    console.log(`\n🎊 Setup complete! Your Next.js app should now be running!`)
    console.log(`💻 Check the preview URL above to access your application.`)
    console.log(`📊 Monitor the logs bellow for any issues.\n`)
    await runCommand(sandbox, {name: 'npm-run-dev', command: 'npm run dev', workingDir: '/home/user/nextjs-sandbox-test', waitForCompletion: false, maxWait: 15 * 60 * 1000})

  } catch (e) {
    console.error("❌ There was an error => ", e);
  }
}

main()
  .catch((err) => {
    console.error("There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  })
