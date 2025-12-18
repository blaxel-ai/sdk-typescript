import { SandboxInstance, VolumeInstance } from "@blaxel/core";
import { bench, describe, beforeAll, afterAll } from "vitest";

// ============ CONFIGURATION ============
const SANDBOX_NAME = "bench-npm-install";
const VOLUME_NAME = "bench-npm-volume";
const MEMORY = 8192;
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
    "webflow-api": "3.2.0",
    zod: "4.0.13",
  },
  devDependencies: {
    "@astrojs/check": "0.9.4",
    "@cloudflare/workers-types": "4.20250726.0",
    "tw-animate-css": "1.3.6",
    wrangler: "4.26.1",
  },
};

let sandbox: SandboxInstance | null = null;
let volume: VolumeInstance | null = null;

async function waitForSandboxDeletion(
  sandboxName: string,
  maxAttempts: number = 30
): Promise<boolean> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    } catch {
      return true;
    }
  }
  return false;
}

describe("npm install benchmark", () => {
  beforeAll(async () => {
    console.log(`\n🚀 Setting up npm install benchmark`);
    console.log(`   Memory: ${MEMORY}MB`);

    // Cleanup existing resources
    try {
      await SandboxInstance.delete(SANDBOX_NAME);
      await waitForSandboxDeletion(SANDBOX_NAME, 30);
    } catch {
      // Doesn't exist
    }

    try {
      await VolumeInstance.delete(VOLUME_NAME);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      // Doesn't exist
    }

    // Create volume
    console.log("📦 Creating volume...");
    volume = await VolumeInstance.create({
      name: VOLUME_NAME,
      displayName: `Test Volume for npm benchmark`,
      size: 10240,
    });
    console.log(`✅ Volume created: ${volume.name}`);

    // Create sandbox
    console.log("📦 Creating sandbox...");
    sandbox = await SandboxInstance.create({
      name: SANDBOX_NAME,
      image: "blaxel/node:latest",
      memory: MEMORY,
      volumes: [
        {
          name: VOLUME_NAME,
          mountPath: "/home/user/volume",
          readOnly: false,
        },
      ],
    });
    console.log(`✅ Sandbox created: ${sandbox.metadata?.name}`);

    // Setup working directory
    const workingDir = "/home/user/volume";
    await sandbox.process.exec({
      command: `mkdir -p ${workingDir}`,
      waitForCompletion: true,
    });

    // Write package.json
    console.log("📝 Writing package.json...");
    await sandbox.process.exec({
      command: `cat > ${workingDir}/package.json << 'EOF'\n${JSON.stringify(packageJson, null, 2)}\nEOF`,
      waitForCompletion: true,
    });
    console.log("✅ Setup complete");
  }, 600000); // 10 min timeout

  afterAll(async () => {
    // Cleanup is optional - uncomment if you want to delete resources after bench
    // if (sandbox) {
    //   try {
    //     await SandboxInstance.delete(SANDBOX_NAME);
    //   } catch {}
    // }
    // if (volume) {
    //   try {
    //     await VolumeInstance.delete(VOLUME_NAME);
    //   } catch {}
    // }
    console.log(`\n💾 Sandbox '${SANDBOX_NAME}' and volume remain available.`);
  });

  bench(
    "npm install",
    async () => {
      const workingDir = "/home/user/volume";

      // Clear node_modules before each run
      await sandbox!.process.exec({
        command: `rm -rf ${workingDir}/node_modules ${workingDir}/package-lock.json`,
        waitForCompletion: true,
      });

      const installProcess = await sandbox!.process.exec({
        name: `npm-install-bench-${Date.now()}`,
        command: `cd ${workingDir} && npm install`,
        waitForCompletion: true,
      });

      if (installProcess.exitCode !== 0) {
        throw new Error(`npm install failed with exit code: ${installProcess.exitCode}`);
      }
    },
    { iterations: 3, warmupIterations: 1, time: 0 }
  );

  bench(
    "pnpm install",
    async () => {
      const workingDir = "/home/user/volume";

      // Clear node_modules before each run
      await sandbox!.process.exec({
        command: `rm -rf ${workingDir}/node_modules ${workingDir}/pnpm-lock.yaml`,
        waitForCompletion: true,
      });

      // Ensure pnpm is installed
      await sandbox!.process.exec({
        command: "npm install -g pnpm",
        waitForCompletion: true,
      });

      const installProcess = await sandbox!.process.exec({
        name: `pnpm-install-bench-${Date.now()}`,
        command: `cd ${workingDir} && pnpm install`,
        waitForCompletion: true,
      });

      if (installProcess.exitCode !== 0) {
        throw new Error(`pnpm install failed with exit code: ${installProcess.exitCode}`);
      }
    },
    { iterations: 3, warmupIterations: 1, time: 0 }
  );
});
