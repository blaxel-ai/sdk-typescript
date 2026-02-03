import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultLabels, uniqueName } from "./helpers.js"

// ============ CONFIGURATION ============
const MEMORY = 4096
const REPO_URL = "https://github.com/expressjs/express.git"
const NUM_FILES_TO_ADD = 10
const NUM_FILES_TO_MODIFY = 20
// =======================================

interface SandboxConfig {
  sandbox: SandboxInstance
  volumeName: string | null
  workingDir: string
}

async function createSandbox(withVolume: boolean): Promise<SandboxConfig> {
  const baseName = uniqueName(`bench-git-${withVolume ? "vol" : "novol"}`)
  const volumeName = withVolume ? `${baseName}-vol` : null
  const workingDir = withVolume ? "/home/user/volume/repo" : "/home/user/repo"

  // Create volume if needed
  if (withVolume && volumeName) {
    await VolumeInstance.create({
      name: volumeName,
      displayName: `Git benchmark volume`,
      size: 4096, // 4GB
    })
  }

  // Create sandbox
  const sandbox = await SandboxInstance.create({
    name: baseName,
    image: "blaxel/base-image:latest",
    labels: defaultLabels,
    memory: MEMORY,
    volumes: withVolume && volumeName
      ? [{ name: volumeName, mountPath: "/home/user/volume", readOnly: false }]
      : undefined,
  })

  return { sandbox, volumeName, workingDir }
}

interface BenchmarkResults {
  cloneTime: number
  addFilesTime: number
  modifyFilesTime: number
  gitDiffTime: number
  gitAddTime: number
  gitCommitTime: number
  totalTime: number
}

async function runGitBenchmark(config: SandboxConfig): Promise<BenchmarkResults> {
  const { sandbox, workingDir } = config
  const results: BenchmarkResults = {
    cloneTime: 0,
    addFilesTime: 0,
    modifyFilesTime: 0,
    gitDiffTime: 0,
    gitAddTime: 0,
    gitCommitTime: 0,
    totalTime: 0,
  }

  const totalStart = Date.now()

  // Configure git user for commits
  await sandbox.process.exec({
    command: `git config --global user.email "bench@test.com" && git config --global user.name "Benchmark"`,
    waitForCompletion: true,
  })

  // Clean up any existing directory (important for volumes that persist data)
  await sandbox.process.exec({
    command: `rm -rf ${workingDir}`,
    waitForCompletion: true,
  })

  // 1. Clone repository
  const cloneStart = Date.now()
  const cloneResult = await sandbox.process.exec({
    command: `git clone --depth 1 ${REPO_URL} ${workingDir}`,
    waitForCompletion: true,
  })
  results.cloneTime = Date.now() - cloneStart

  if (cloneResult.exitCode !== 0) {
    throw new Error(`Clone failed: ${cloneResult.logs}`)
  }

  // 2. Add new files
  const addFilesStart = Date.now()

  // Create files in batches for efficiency
  const batchSize = 10
  for (let batch = 0; batch < NUM_FILES_TO_ADD / batchSize; batch++) {
    const commands: string[] = []
    for (let i = 0; i < batchSize; i++) {
      const fileNum = batch * batchSize + i
      // Generate some content for each file
      commands.push(
        `cat > ${workingDir}/benchmark-file-${fileNum}.js << 'EOF'
// Benchmark file ${fileNum}
const data = ${JSON.stringify({ fileNum, timestamp: Date.now(), content: "x".repeat(1000) })};
module.exports = { data };
export default data;
EOF`
      )
    }
    await sandbox.process.exec({
      command: commands.join(" && "),
      waitForCompletion: true,
    })
  }
  results.addFilesTime = Date.now() - addFilesStart

  // 3. Modify existing files
  const modifyFilesStart = Date.now()

  // Find some existing .js files to modify
  const findResult = await sandbox.process.exec({
    command: `find ${workingDir}/lib -name "*.js" -type f | head -${NUM_FILES_TO_MODIFY}`,
    waitForCompletion: true,
  })

  const filesToModify = findResult.logs.trim().split("\n").filter(Boolean)

  // Append content to each file
  const modifyCommands = filesToModify.map(
    (file) => `echo "// Modified by benchmark at $(date)" >> "${file}"`
  )

  if (modifyCommands.length > 0) {
    await sandbox.process.exec({
      command: modifyCommands.join(" && "),
      waitForCompletion: true,
    })
  }
  results.modifyFilesTime = Date.now() - modifyFilesStart

  // 4. Run git diff
  const gitDiffStart = Date.now()
  await sandbox.process.exec({
    command: `cd ${workingDir} && git diff --stat`,
    waitForCompletion: true,
  })
  results.gitDiffTime = Date.now() - gitDiffStart

  // 5. Git add all changes
  const gitAddStart = Date.now()
  await sandbox.process.exec({
    command: `cd ${workingDir} && git add -A`,
    waitForCompletion: true,
  })
  results.gitAddTime = Date.now() - gitAddStart

  // 6. Git commit
  const gitCommitStart = Date.now()
  await sandbox.process.exec({
    command: `cd ${workingDir} && git commit -m "Benchmark commit: added ${NUM_FILES_TO_ADD} files, modified ${NUM_FILES_TO_MODIFY} files"`,
    waitForCompletion: true,
  })
  results.gitCommitTime = Date.now() - gitCommitStart

  results.totalTime = Date.now() - totalStart

  // Print summary

  return results
}

// Create sandboxes in parallel at module load time
// Global teardown will clean these up based on labels
const volumeSandboxPromise = createSandbox(true)
const noVolumeSandboxPromise = createSandbox(false)

// Cache for resolved configs
let volumeConfig: SandboxConfig | null = null
let noVolumeConfig: SandboxConfig | null = null

describe("git operations benchmark - volume vs no volume", () => {
  bench(
    "git operations (with volume)",
    async () => {
      if (!volumeConfig) {
        volumeConfig = await volumeSandboxPromise
      }
      await runGitBenchmark(volumeConfig)
    },
    {
      iterations: 1,
      warmupIterations: 0,
    }
  )

  bench(
    "git operations (no volume)",
    async () => {
      if (!noVolumeConfig) {
        noVolumeConfig = await noVolumeSandboxPromise
      }
      await runGitBenchmark(noVolumeConfig)
    },
    {
      iterations: 1,
      warmupIterations: 0,
    }
  )
})
