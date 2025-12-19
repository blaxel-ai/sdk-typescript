import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultLabels, uniqueName } from "./helpers.js"

// ============ CONFIGURATION ============
const MEMORY = 8192
// =======================================

const packageJson = {
  name: "performance-test",
  version: "1.0.0",
  dependencies: {
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
    astro: "5.13.5",
    "class-variance-authority": "0.7.1",
    clsx: "2.1.1",
    cmdk: "1.1.1",
    "date-fns": "4.1.0",
    "embla-carousel-react": "8.6.0",
    "input-otp": "1.4.2",
    "lucide-react": "0.533.0",
    "next-themes": "0.4.6",
    react: "19.1.1",
    "react-day-picker": "9.8.1",
    "react-dom": "19.1.1",
    "react-hook-form": "7.61.1",
    "react-resizable-panels": "3.0.3",
    recharts: "2.15.4",
    sonner: "2.0.6",
    "tailwind-merge": "3.3.1",
    tailwindcss: "4.1.11",
    vaul: "1.1.2",
    zod: "4.0.13",
  },
  devDependencies: {
    "@astrojs/check": "0.9.4",
    "@cloudflare/workers-types": "4.20250726.0",
    "tw-animate-css": "1.3.6",
    wrangler: "4.26.1",
  },
}

type PackageManager = "npm" | "yarn" | "pnpm" | "bun"

interface SandboxConfig {
  sandbox: SandboxInstance
  volumeName: string | null
  workingDir: string
}

function getSandboxKey(pm: PackageManager, withVolume: boolean): string {
  return `${pm}-${withVolume ? "volume" : "no-volume"}`
}

async function createSandbox(pm: PackageManager, withVolume: boolean): Promise<SandboxConfig> {
  const baseName = uniqueName(`bench-${pm}-${withVolume ? "vol" : "novol"}`)
  const volumeName = withVolume ? `${baseName}-vol` : null
  const workingDir = withVolume ? "/home/user/volume" : "/home/user/project"

  // Create volume if needed
  if (withVolume && volumeName) {
    await VolumeInstance.create({
      name: volumeName,
      displayName: `Test Volume for ${pm} benchmark`,
      size: 10240,
    })
  }

  // Create sandbox
  const sandbox = await SandboxInstance.create({
    name: baseName,
    image: "blaxel/node:latest",
    labels: defaultLabels,
    memory: MEMORY,
    volumes: withVolume && volumeName
      ? [{ name: volumeName, mountPath: "/home/user/volume", readOnly: false }]
      : undefined,
  })

  // Setup working directory
  await sandbox.process.exec({
    command: `mkdir -p ${workingDir}`,
    waitForCompletion: true,
  })

  // Write package.json
  await sandbox.process.exec({
    command: `cat > ${workingDir}/package.json << 'EOF'\n${JSON.stringify(packageJson, null, 2)}\nEOF`,
    waitForCompletion: true,
  })

  // Install package manager if not npm
  if (pm === "yarn") {
    await sandbox.process.exec({ command: "npm install -g yarn", waitForCompletion: true })
  } else if (pm === "pnpm") {
    await sandbox.process.exec({ command: "npm install -g pnpm", waitForCompletion: true })
  } else if (pm === "bun") {
    await sandbox.process.exec({ command: "npm install -g bun", waitForCompletion: true })
  }

  return { sandbox, volumeName, workingDir }
}

function getLockFile(pm: PackageManager): string {
  switch (pm) {
    case "npm": return "package-lock.json"
    case "yarn": return "yarn.lock"
    case "pnpm": return "pnpm-lock.yaml"
    case "bun": return "bun.lockb"
  }
}

function getInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case "npm": return "npm install"
    case "yarn": return "yarn install"
    case "pnpm": return "pnpm install"
    case "bun": return "bun install"
  }
}

const packageManagers: PackageManager[] = ["bun", "yarn", "pnpm", "npm"]
// const packageManagers: PackageManager[] = ["npm"]

// Create all sandbox promises in parallel at module load time

const sandboxPromises: Record<string, Promise<SandboxConfig>> = {}
for (const pm of packageManagers) {
  sandboxPromises[getSandboxKey(pm, true)] = createSandbox(pm, true)
  sandboxPromises[getSandboxKey(pm, false)] = createSandbox(pm, false)
}

// Resolved configs cache
const sandboxConfigs: Record<string, SandboxConfig> = {}

describe("package manager install benchmarks", () => {
  for (const pm of packageManagers) {
    getSandboxKey(pm, true)
    const noVolumeKey = getSandboxKey(pm, false)

    // Volume does not work great currently testing all of those
    // bench(
    //   `${pm} install (with volume)`,
    //   async () => {
    //     const config = sandboxConfigs[volumeKey]
    //     const { sandbox, workingDir } = config

    //     const processName = `${pm}-install-bench-${Date.now()}`
    //     await sandbox.process.exec({
    //       name: processName,
    //       command: `cd ${workingDir} && ${getInstallCommand(pm)}`,
    //       waitForCompletion: true,
    //       onLog: (log) => {
    //       },
    //     })

    //     const process = await sandbox.process.wait(processName, { maxWait: 1800000, interval: 100 })
    //     if (process.exitCode !== 0) {
    //       throw new Error(`${pm} install failed with exit code: ${process.exitCode}`)
    //     }
    //     console.log(`${pm} install completed`)
    //   },
    //   {
    //     iterations: 1,
    //     warmupIterations: 0,
    //     setup: async () => {
    //       // Wait for sandbox to be ready
    //       sandboxConfigs[volumeKey] = await sandboxPromises[volumeKey]
    //       const { sandbox, workingDir } = sandboxConfigs[volumeKey]
    //       const lockFile = getLockFile(pm)
    //       // Clear node_modules and lock file before run
    //       await sandbox.process.exec({
    //         command: `rm -rf ${workingDir}/node_modules ${workingDir}/${lockFile}`,
    //         waitForCompletion: true,
    //       })
    //     },
    //   }
    // )

    bench(
      `${pm} install (no volume)`,
      async () => {
        const config = sandboxConfigs[noVolumeKey]
        const { sandbox, workingDir } = config

        const installProcess = await sandbox.process.exec({
          name: `${pm}-install-bench-${Date.now()}`,
          command: `cd ${workingDir} && ${getInstallCommand(pm)}`,
          waitForCompletion: true,
          onLog: () => {},
        })

        if (installProcess.exitCode !== 0) {
          throw new Error(`${pm} install failed with exit code: ${installProcess.exitCode}`)
        }
        console.log(`[${pm}-no-volume] install completed`)
      },
      {
        iterations: 1,
        warmupIterations: 0,
        setup: async () => {
          // Wait for sandbox to be ready
          sandboxConfigs[noVolumeKey] = await sandboxPromises[noVolumeKey]
          const { sandbox, workingDir } = sandboxConfigs[noVolumeKey]
          const lockFile = getLockFile(pm)
          // Clear node_modules and lock file before run
          await sandbox.process.exec({
            command: `rm -rf ${workingDir}/node_modules ${workingDir}/${lockFile}`,
            waitForCompletion: true,
          })
        },
      }
    )
  }
})
