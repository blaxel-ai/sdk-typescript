import { SandboxInstance } from "@blaxel/core";
import AdmZip from "adm-zip";
import * as fs from "fs";
import path from "path";

export const sep = '--------------------------------'

export const info = (msg: string) => console.log(`[INFO] ${msg}`)

export async function localSandbox(sandboxName: string) {
  process.env[`BL_SANDBOXES_${sandboxName.replace(/-/g, "_").toUpperCase()}_URL`] = "http://localhost:8080"
  const sandbox = new SandboxInstance({
    metadata: {
      name: sandboxName
    },
  })
  return sandbox
}


export async function createOrGetSandbox({sandboxName, image = "blaxel/prod-nextjs:latest", ports = [], memory = 4096, envs = []}: {sandboxName: string, image?: string, ports?: { name: string, target: number, protocol: string, envs?: { name: string, value: string }[] }[], memory?: number, envs?: { name: string, value: string }[]}) {
  // return localSandbox(sandboxName)
  if (ports.length === 0) {
    ports.push({
      name: "sandbox-api",
      target: 8080,
      protocol: "HTTP",
    })
    ports.push({
      name: "expo-web",
      target: 8081,
      protocol: "HTTP",
    })
    ports.push({
      name: "preview",
      target: 3000,
      protocol: "HTTP",
    })
  }
  const sandboxModel = {
    metadata: {
      name: sandboxName
    },
    spec: {
      runtime: {
        image,
        memory,
        ports,
        envs
      }
    }
  }
  const sandbox = await SandboxInstance.createIfNotExists(sandboxModel)
  await sandbox.wait({ maxWait: 120000, interval: 1000 })
  return sandbox
}

export async function runCommand(sandbox: SandboxInstance, {name = undefined, command, maxWait, workingDir, waitForCompletion = true}: {name?: string, command: string, maxWait?: number, workingDir?: string, waitForCompletion?: boolean}) {
  info(`⚡ Running: ${command}`)
  let process =await sandbox.process.exec({
    name,
    command,
    waitForCompletion,
    workingDir,
  })
  const processName = name || process.name!
  if (!waitForCompletion) {
    const stream = sandbox.process.streamLogs(processName, {
      onLog(log) {
        console.log(`[${processName}] ${log}`)
      }
    })
    if (maxWait) {
      await sandbox.process.wait(processName, { maxWait: maxWait, interval: 1000 })
    }
    stream.close()
  } else {
    const logs = await sandbox.process.logs(processName, "all")
    if (logs) {
      console.log(`--- Logs for ${processName} ---`)
      console.log(logs)
      console.log(`--- End logs for ${processName} ---`)
    }
  }

  process = await sandbox.process.get(processName)
  console.log(`${processName} status: ${process?.status}`)
  if (process?.status === 'failed') {
    console.log(`${processName} exit code: ${process?.exitCode}`)
    console.log(`${processName} logs: ${await sandbox.process.logs(processName, "all")}`)
  }
}

export function createZipFromDirectory(sourceDir: string, outputPath: string): void {
  const zip = new AdmZip();
  const dirName = path.basename(sourceDir);

  // Folders to ignore
  const ignoredFolders = ['node_modules', '.next', '.DS_Store'];

  function addDirectoryToZip(currentPath: string, zipPath: string) {
    const items = fs.readdirSync(currentPath);

    for (const item of items) {
      // Skip ignored files and folders
      if (ignoredFolders.includes(item)) {
        continue;
      }

      const fullPath = path.join(currentPath, item);
      const zipItemPath = path.join(zipPath, item);

      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Recursively add directory contents
        addDirectoryToZip(fullPath, zipItemPath);
      } else {
        // Add file to zip
        zip.addLocalFile(fullPath, path.dirname(zipItemPath), path.basename(zipItemPath));
      }
    }
  }

  // Add the directory contents with the directory name as root
  addDirectoryToZip(sourceDir, dirName);

  // Write the zip file
  zip.writeZip(outputPath);
}

export async function createPreview(sandbox: SandboxInstance) {
  const preview = await sandbox.previews.createIfNotExists({
    metadata: {
      name: "preview-nextjs"
    },
    spec: {
      port: 3000,
      public: true
    }
  })
  return preview
}

export async function checkUsage(sandbox: SandboxInstance) {
  console.log(sep)
  console.log("💰 Checking usage")
  const diskSpace = await sandbox.process.exec({
    name: 'disk-space',
    command: 'df -m',
    workingDir: '/home/user'
  })
  const memory = await sandbox.process.exec({
    name: 'memory',
    command: 'free -m',
    workingDir: '/home/user'
  })
  const memoryLogs = await sandbox.process.logs(memory.pid!, 'all')
  const diskSpaceLogs = await sandbox.process.logs(diskSpace.pid!, 'all')
  console.log(`🧠 Memory:\n${memoryLogs}`)
  console.log(`💾 Disk Space:\n${diskSpaceLogs}`)
}