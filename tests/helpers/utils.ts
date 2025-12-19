import { SandboxCreateConfiguration, SandboxInstance } from "@blaxel/core";
import AdmZip from "adm-zip";
import * as fs from "fs";
import path from "path";
import { v4 as uuidv4 } from 'uuid';

const env = process.env.BL_ENV || "prod"

export const sep = '--------------------------------'

export const info = (msg: string) => console.log(`[INFO] ${msg}`)

export async function localSandbox(sandboxName: string) {
  info(`Using local sandbox ${sandboxName}`)
  const sandbox = new SandboxInstance({
    metadata: {
      name: sandboxName
    },
    forceUrl: "http://localhost:8080"
  })
  return sandbox
}


export async function createOrGetSandbox(config: SandboxCreateConfiguration = {}) {
  const sandboxName = config.name || `test-${uuidv4().replace(/-/g, '').substring(0, 8)}`
  const region = config.region || process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1"
  const image = config.image || "blaxel/nextjs:latest"
  const memory = config.memory || 4096
  const envs = config.envs || []
  const ports = config.ports || []
  if (ports.length === 0) {
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
      name: sandboxName,
      labels: config.labels
    },
    spec: {
      region,
      runtime: {
        image,
        memory,
        ports,
        envs
      }
    }
  }
  const sandbox = await SandboxInstance.createIfNotExists(sandboxModel)
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

export function getModels() {
  return [
    "gpt-5-1",
    "claude-sonnet-4-5",
    "cerebras-sandbox",
    "cohere-command-a-reasoning",
    "mistral-large-latest",
    "deepseek-chat",
    "gemini-3-pro-preview",
    "xai-grok-beta",
  ]
}
