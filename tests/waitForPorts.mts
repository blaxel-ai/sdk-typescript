import { SandboxInstance } from "@blaxel/core"

async function createViteSandbox() {
  const sandbox = await SandboxInstance.create({
    image: "blaxel/vite:latest",
    labels: {
      "type": "vite"
    },
    memory: 4096,
    ports: [
      { target: 5173, protocol: "HTTP" }
    ]
  })

  await sandbox.fs.write("/blaxel/app/vite.config.ts", `export default {
    server: {
      host: '0.0.0.0',
      allowedHosts: true
    }
  }`)

  const process = await sandbox.process.exec({
    command: "npm run dev -- --port 5173",
    workingDir: "/blaxel/app",
    waitForPorts: [5173],
  })
  console.log("[Vite] Process created and ready => ", process.name)
  console.log("[Vite] Process logs => ", await sandbox.process.get(process.name))
  const preview = await sandbox.previews.createIfNotExists({
    metadata: {
      name: "wait-for-ports-test"
    },
    spec: {
      port: 5173,
      public: true
    }
  })
  console.log("[Vite] Preview created and ready")
  console.log("[Vite] Preview URL => ", preview.spec?.url)
}

async function createNextjsSandbox() {
  const sandbox = await SandboxInstance.create({
    image: "blaxel/nextjs:latest",
    labels: {
      "type": "nextjs"
    },
    memory: 4096,
    ports: [
      { target: 3000, protocol: "HTTP" }
    ]
  })
  const process = await sandbox.process.exec({
    command: "npm run dev -- --port 3000",
    workingDir: "/blaxel/app",
    waitForPorts: [30002],
  })
  console.log("[Nextjs] Process created and ready => ", process.name)
  console.log("[Nextjs] Process logs => ", await sandbox.process.get(process.name))

  const preview = await sandbox.previews.createIfNotExists({
    metadata: {
      name: "wait-for-ports-test"
    },
    spec: {
      port: 3000,
      public: true
    }
  })
  console.log("[Nextjs] Preview created and ready")
  console.log("[Nextjs] Preview URL => ", preview.spec?.url)
}

async function localTest() {
  const sandbox = new SandboxInstance({
    metadata: {
      name: "wait-for-ports-test-local"
    },
    forceUrl: "http://localhost:8080"
  })
  const process = await sandbox.process.exec({
    command: "npm run dev -- --port 3000",
    workingDir: "/blaxel/app",
    waitForPorts: [30002],
  })
  console.log("[Local] Process created and ready => ", process.name)
  console.log("[Local] Process logs => ", await sandbox.process.get(process.name))
}


// await createViteSandbox()
// await createNextjsSandbox()
await localTest()
