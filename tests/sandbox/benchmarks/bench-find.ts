import { SandboxInstance } from "@blaxel/core";

// ============ CONFIGURATION ============
const ITERATIONS_PER_TEST = 20;
const WARMUP_ITERATIONS = 3;
const SANDBOX_NAME = "fzf-test";
const REPO_URL = "https://github.com/vercel/next.js.git"; // Larger repo
const REPO_PATH = "/workspace/nextjs-repo";
const SETUP_ENVIRONMENT = true;
// =======================================

interface BenchResult {
  method: 'find-bash' | 'fd' | 'native-find';
  iteration: number;
  duration: number;
  fileCount: number;
  success: boolean;
  error?: string;
}

interface Stats {
  method: string;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  avgFileCount: number;
}

function calculateStats(results: BenchResult[]): Stats {
  const successful = results.filter(r => r.success);
  const durations = successful.map(r => r.duration).sort((a, b) => a - b);
  const fileCounts = successful.map(r => r.fileCount);

  return {
    method: results[0]?.method || 'unknown',
    avg: durations.reduce((sum, d) => sum + d, 0) / durations.length || 0,
    min: durations[0] || 0,
    max: durations[durations.length - 1] || 0,
    p50: durations[Math.floor(durations.length * 0.5)] || 0,
    p95: durations[Math.floor(durations.length * 0.95)] || 0,
    p99: durations[Math.floor(durations.length * 0.99)] || 0,
    avgFileCount: fileCounts.reduce((sum, c) => sum + c, 0) / fileCounts.length || 0,
  };
}

async function setupEnvironment(sandbox: SandboxInstance): Promise<void> {
  console.log(`📦 Setting up environment...`);

  console.log(`   Installing fd...`);
  await sandbox.process.exec({
    command: `curl -L https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz | tar xz && mv fd-v10.2.0-x86_64-unknown-linux-musl/fd /usr/local/bin/fd`,
    waitForCompletion: true,
  });

  console.log(`   Cloning ${REPO_URL}...`);
  await sandbox.process.exec({
    command: `git clone --depth 1 ${REPO_URL} ${REPO_PATH}`,
    waitForCompletion: true,
  });

  console.log(`   Running npm install...`);
  await sandbox.process.exec({
    command: `cd ${REPO_PATH} && npm install`,
    waitForCompletion: true,
  });

  console.log(`✓ Environment ready`);
}

async function benchFind(sandbox: SandboxInstance, method: 'find-bash' | 'fd' | 'native-find'): Promise<BenchResult> {
  const start = Date.now();
  let fileCount = 0;
  let success = true;
  let error: string | undefined;

  try {
    if (method === 'native-find') {
      const result = await sandbox.fs.find(
        REPO_PATH,
        {
          type: 'file',
          patterns: ['*.json','*.html'],
          maxResults: 1000,
          // excludeHidden: true,
        }
      );
      fileCount = result.matches?.length || 0;
    } else if (method === 'fd') {
      const result = await sandbox.process.exec({
        command: `fd -t f -e json -e html . ${REPO_PATH} | head -1000`,
        waitForCompletion: true,
      });
      const output = result.logs || "";
      const lines = output.trim().split('\n').filter(l => l);
      fileCount = lines.length;
    } else {
      const result = await sandbox.process.exec({
        command: `find ${REPO_PATH} -type f \\( -name "*.json" -o -name "*.html" \\) | head -1000`,
        waitForCompletion: true,
      });
      const output = result.logs || "";
      const lines = output.trim().split('\n').filter(l => l);
      fileCount = lines.length;
    }
  } catch (e) {
    success = false;
    error = e instanceof Error ? e.message : String(e);
  }

  const duration = Date.now() - start;

  return {
    method,
    iteration: 0,
    duration,
    fileCount,
    success,
    error,
  };
}

async function main() {
  console.log("========================================");
  console.log("  BASH FIND vs NATIVE FIND");
  console.log("  BENCHMARK");
  console.log("========================================");
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Sandbox: ${SANDBOX_NAME}`);
  console.log(`   Repository: ${REPO_URL}`);
  console.log(`   Path: ${REPO_PATH}`);
  console.log(`   Iterations: ${ITERATIONS_PER_TEST}`);
  console.log(`   Warmup: ${WARMUP_ITERATIONS}\n`);

  let sandbox: SandboxInstance | null = null;

  try {
    console.log(`🔗 Connecting to sandbox: ${SANDBOX_NAME}...`);
    sandbox = await SandboxInstance.get(SANDBOX_NAME);
    console.log(`✓ Connected\n`);

    if (SETUP_ENVIRONMENT) {
      try {
        await setupEnvironment(sandbox);
      } catch (error) {
        console.log(`⚠️  Setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Validation
    console.log("\n🔍 Validation...");

    const bashValidation = await sandbox.process.exec({
      command: `find ${REPO_PATH} -type f \\( -name "*.json" -o -name "*.html" \\) | head -100 | wc -l`,
      waitForCompletion: true,
    });
    const bashCount = parseInt((bashValidation.logs || "").trim()) || 0;
    console.log(`   find-bash: ${bashCount} files`);

    const fdValidation = await sandbox.process.exec({
      command: `fd -t f -e json -e html . ${REPO_PATH} | head -100 | wc -l`,
      waitForCompletion: true,
    });
    const fdCount = parseInt((fdValidation.logs || "").trim()) || 0;
    console.log(`   fd:        ${fdCount} files`);

    const nativeValidation = await sandbox.fs.find(
      REPO_PATH,
      {
        type: 'file',
        patterns: ['*.json', '*.html'],
        maxResults: 100,
        excludeHidden: true,
      }
    );
    console.log(`   native:    ${nativeValidation.matches?.length || 0} matches`);
    console.log(`   Sample files:`);
    nativeValidation.matches?.slice(0, 3).forEach(m => console.log(`     - ${m.path} (${m.type})`));

    const allResults: BenchResult[] = [];

    // Warmup
    console.log(`\n🔥 Warmup (${WARMUP_ITERATIONS} iterations)...`);
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      await benchFind(sandbox, 'find-bash');
      await benchFind(sandbox, 'fd');
      await benchFind(sandbox, 'native-find');
    }
    console.log(`✓ Warmup complete`);

    // Benchmark bash find
    console.log(`\n📊 Benchmarking find-bash (${ITERATIONS_PER_TEST} iterations)...`);
    for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
      const result = await benchFind(sandbox, 'find-bash');
      result.iteration = i + 1;
      allResults.push(result);
      if ((i + 1) % 5 === 0) console.log(`   Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
    }

    // Benchmark fd
    console.log(`\n📊 Benchmarking fd (${ITERATIONS_PER_TEST} iterations)...`);
    for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
      const result = await benchFind(sandbox, 'fd');
      result.iteration = i + 1;
      allResults.push(result);
      if ((i + 1) % 5 === 0) console.log(`   Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
    }

    // Benchmark native find
    console.log(`\n📊 Benchmarking native-find (${ITERATIONS_PER_TEST} iterations)...`);
    for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
      const result = await benchFind(sandbox, 'native-find');
      result.iteration = i + 1;
      allResults.push(result);
      if ((i + 1) % 5 === 0) console.log(`   Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
    }

    // Calculate statistics
    const bashResults = allResults.filter(r => r.method === 'find-bash');
    const fdResults = allResults.filter(r => r.method === 'fd');
    const nativeResults = allResults.filter(r => r.method === 'native-find');

    const bashStats = calculateStats(bashResults);
    const fdStats = calculateStats(fdResults);
    const nativeStats = calculateStats(nativeResults);

    // Display results
    console.log("\n\n========================================");
    console.log("           RESULTS");
    console.log("========================================\n");

    console.log("Method        | Avg (ms) | Min (ms) | Max (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Avg Files | Success");
    console.log("--------------|----------|----------|----------|----------|----------|----------|-----------|--------");

    const bashSuccessRate = (bashResults.filter(r => r.success).length / bashResults.length) * 100;
    console.log(`find-bash     | ${bashStats.avg.toFixed(1).padStart(8)} | ${bashStats.min.toFixed(1).padStart(8)} | ${bashStats.max.toFixed(1).padStart(8)} | ${bashStats.p50.toFixed(1).padStart(8)} | ${bashStats.p95.toFixed(1).padStart(8)} | ${bashStats.p99.toFixed(1).padStart(8)} | ${bashStats.avgFileCount.toFixed(1).padStart(9)} | ${bashSuccessRate.toFixed(0)}%`);

    const fdSuccessRate = (fdResults.filter(r => r.success).length / fdResults.length) * 100;
    console.log(`fd            | ${fdStats.avg.toFixed(1).padStart(8)} | ${fdStats.min.toFixed(1).padStart(8)} | ${fdStats.max.toFixed(1).padStart(8)} | ${fdStats.p50.toFixed(1).padStart(8)} | ${fdStats.p95.toFixed(1).padStart(8)} | ${fdStats.p99.toFixed(1).padStart(8)} | ${fdStats.avgFileCount.toFixed(1).padStart(9)} | ${fdSuccessRate.toFixed(0)}%`);

    const nativeSuccessRate = (nativeResults.filter(r => r.success).length / nativeResults.length) * 100;
    console.log(`native-find   | ${nativeStats.avg.toFixed(1).padStart(8)} | ${nativeStats.min.toFixed(1).padStart(8)} | ${nativeStats.max.toFixed(1).padStart(8)} | ${nativeStats.p50.toFixed(1).padStart(8)} | ${nativeStats.p95.toFixed(1).padStart(8)} | ${nativeStats.p99.toFixed(1).padStart(8)} | ${nativeStats.avgFileCount.toFixed(1).padStart(9)} | ${nativeSuccessRate.toFixed(0)}%`);

    console.log("\n\nCOMPARISON");
    console.log("----------");
    console.log(`find-bash:   ${bashStats.avg.toFixed(1)} ms (avg ${bashStats.avgFileCount.toFixed(1)} files)`);
    console.log(`fd:          ${fdStats.avg.toFixed(1)} ms (avg ${fdStats.avgFileCount.toFixed(1)} files)`);
    console.log(`native-find: ${nativeStats.avg.toFixed(1)} ms (avg ${nativeStats.avgFileCount.toFixed(1)} files)`);

    const times = [
      { method: 'find-bash', avg: bashStats.avg },
      { method: 'fd', avg: fdStats.avg },
      { method: 'native-find', avg: nativeStats.avg },
    ].sort((a, b) => a.avg - b.avg);

    console.log(`\nFastest: ${times[0].method} (${times[0].avg.toFixed(1)} ms)`);
    console.log(`Slowest: ${times[2].method} (${times[2].avg.toFixed(1)} ms)`);
    console.log(`Speedup (fastest vs slowest): ${(times[2].avg / times[0].avg).toFixed(2)}x`);

    console.log("\n========================================\n");

  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    throw error;
  }

  console.log(`💾 Sandbox '${SANDBOX_NAME}' remains available.`);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

