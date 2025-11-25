import { SandboxInstance } from "@blaxel/core";
import console from "console";

// ============ CONFIGURATION ============
const ITERATIONS_PER_TEST = 20;
const WARMUP_ITERATIONS = 3;
const SANDBOX_NAME = "fzf-test";
const REPO_URL = "https://github.com/relace-ai/vite-template.git";
const REPO_PATH = "/workspace/vite-grep";
const SEARCH_TERM = "script";
const SETUP_ENVIRONMENT = true;
// =======================================

interface BenchResult {
  method: 'grep-bash' | 'ripgrep' | 'native-grep';
  iteration: number;
  duration: number;
  matchCount: number;
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
  avgMatchCount: number;
}

function calculateStats(results: BenchResult[]): Stats {
  const successful = results.filter(r => r.success);
  const durations = successful.map(r => r.duration).sort((a, b) => a - b);
  const matchCounts = successful.map(r => r.matchCount);

  return {
    method: results[0]?.method || 'unknown',
    avg: durations.reduce((sum, d) => sum + d, 0) / durations.length || 0,
    min: durations[0] || 0,
    max: durations[durations.length - 1] || 0,
    p50: durations[Math.floor(durations.length * 0.5)] || 0,
    p95: durations[Math.floor(durations.length * 0.95)] || 0,
    p99: durations[Math.floor(durations.length * 0.99)] || 0,
    avgMatchCount: matchCounts.reduce((sum, c) => sum + c, 0) / matchCounts.length || 0,
  };
}

async function benchGrep(sandbox: SandboxInstance, method: 'grep-bash' | 'ripgrep' | 'native-grep'): Promise<BenchResult> {
  const start = Date.now();
  let matchCount = 0;
  let success = true;
  let error: string | undefined;

  try {
    if (method === 'native-grep') {
      const result = await sandbox.fs.grep(
        SEARCH_TERM,
        REPO_PATH,
        {
          maxResults: 100,
        }
      );
      matchCount = result.matches?.length || 0;
    } else if (method === 'ripgrep') {
      const result = await sandbox.process.exec({
        command: `rg "${SEARCH_TERM}" ${REPO_PATH} | head -100`,
        waitForCompletion: true,
      });
      const output = result.logs || "";
      const lines = output.trim().split('\n').filter(l => l);
      matchCount = lines.length;
    } else {
      const result = await sandbox.process.exec({
        command: `grep -r "${SEARCH_TERM}" ${REPO_PATH} 2>/dev/null | head -100`,
        waitForCompletion: true,
      });
      const output = result.logs || "";
      const lines = output.trim().split('\n').filter(l => l);
      matchCount = lines.length;
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
    matchCount,
    success,
    error,
  };
}

async function setupEnvironment(sandbox: SandboxInstance): Promise<void> {
  console.log(`📦 Setting up environment...`);

  console.log(`   Installing ripgrep...`);
  await sandbox.process.exec({
    command: `apk add ripgrep`,
    waitForCompletion: true,
  });

  console.log(`   Cloning ${REPO_URL}...`);
  await sandbox.process.exec({
    command: `git clone ${REPO_URL} ${REPO_PATH}`,
    waitForCompletion: true,
  });

  console.log(`✓ Environment ready`);
}

async function main() {
  console.log("========================================");
  console.log("  GREP BENCHMARK");
  console.log("========================================");
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Sandbox: ${SANDBOX_NAME}`);
  console.log(`   Repository: ${REPO_URL}`);
  console.log(`   Path: ${REPO_PATH}`);
  console.log(`   Search term: "${SEARCH_TERM}"`);
  console.log(`   Iterations: ${ITERATIONS_PER_TEST}\n`);

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
    console.log("🔍 Validation...");

    const bashVal = await sandbox.process.exec({
      command: `grep -r "${SEARCH_TERM}" ${REPO_PATH} 2>/dev/null | head -10`,
      waitForCompletion: true,
    });
    const bashLines = (bashVal.logs || "").trim().split('\n').filter(l => l);
    console.log(`   grep-bash:    ${bashLines.length} matches`);
    bashLines.slice(0, 2).forEach(l => console.log(`                 - ${l.substring(0, 80)}`));

    const rgVal = await sandbox.process.exec({
      command: `rg "${SEARCH_TERM}" ${REPO_PATH} | head -10`,
      waitForCompletion: true,
    });
    const rgLines = (rgVal.logs || "").trim().split('\n').filter(l => l);
    console.log(`   ripgrep:      ${rgLines.length} matches`);
    rgLines.slice(0, 2).forEach(l => console.log(`                 - ${l.substring(0, 80)}`));

    const nativeVal = await sandbox.fs.grep(
      SEARCH_TERM,
      REPO_PATH,
      {
        maxResults: 10,
      }
    );
    console.log(`   native-grep:  ${nativeVal.matches?.length || 0} matches`);
    nativeVal.matches?.slice(0, 2).forEach(m => console.log(`                 - ${m.path}:${m.line}: ${m.text?.substring(0, 60)}`));

    const allResults: BenchResult[] = [];

    // Warmup
    console.log(`\n🔥 Warmup (${WARMUP_ITERATIONS} iterations)...`);
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      await benchGrep(sandbox, 'grep-bash');
      await benchGrep(sandbox, 'ripgrep');
      await benchGrep(sandbox, 'native-grep');
    }
    console.log(`✓ Warmup complete`);

    // Benchmark grep-bash
    console.log(`\n📊 Benchmarking grep-bash (${ITERATIONS_PER_TEST} iterations)...`);
    for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
      const result = await benchGrep(sandbox, 'grep-bash');
      result.iteration = i + 1;
      allResults.push(result);
      if ((i + 1) % 5 === 0) console.log(`   Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
    }

    // Benchmark ripgrep
    console.log(`\n📊 Benchmarking ripgrep (${ITERATIONS_PER_TEST} iterations)...`);
    for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
      const result = await benchGrep(sandbox, 'ripgrep');
      result.iteration = i + 1;
      allResults.push(result);
      if ((i + 1) % 5 === 0) console.log(`   Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
    }

    // Benchmark native-grep
    console.log(`\n📊 Benchmarking native-grep (${ITERATIONS_PER_TEST} iterations)...`);
    for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
      const result = await benchGrep(sandbox, 'native-grep');
      result.iteration = i + 1;
      allResults.push(result);
      if ((i + 1) % 5 === 0) console.log(`   Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
    }

    // Calculate statistics
    const bashResults = allResults.filter(r => r.method === 'grep-bash');
    const rgResults = allResults.filter(r => r.method === 'ripgrep');
    const nativeResults = allResults.filter(r => r.method === 'native-grep');

    const bashStats = calculateStats(bashResults);
    const rgStats = calculateStats(rgResults);
    const nativeStats = calculateStats(nativeResults);

    // Display results
    console.log("\n\n========================================");
    console.log("           RESULTS");
    console.log("========================================\n");

    console.log("Method        | Avg (ms) | Min (ms) | Max (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Avg Matches | Success");
    console.log("--------------|----------|----------|----------|----------|----------|----------|-------------|--------");

    const bashSuccessRate = (bashResults.filter(r => r.success).length / bashResults.length) * 100;
    console.log(`grep-bash     | ${bashStats.avg.toFixed(1).padStart(8)} | ${bashStats.min.toFixed(1).padStart(8)} | ${bashStats.max.toFixed(1).padStart(8)} | ${bashStats.p50.toFixed(1).padStart(8)} | ${bashStats.p95.toFixed(1).padStart(8)} | ${bashStats.p99.toFixed(1).padStart(8)} | ${bashStats.avgMatchCount.toFixed(1).padStart(11)} | ${bashSuccessRate.toFixed(0)}%`);

    const rgSuccessRate = (rgResults.filter(r => r.success).length / rgResults.length) * 100;
    console.log(`ripgrep       | ${rgStats.avg.toFixed(1).padStart(8)} | ${rgStats.min.toFixed(1).padStart(8)} | ${rgStats.max.toFixed(1).padStart(8)} | ${rgStats.p50.toFixed(1).padStart(8)} | ${rgStats.p95.toFixed(1).padStart(8)} | ${rgStats.p99.toFixed(1).padStart(8)} | ${rgStats.avgMatchCount.toFixed(1).padStart(11)} | ${rgSuccessRate.toFixed(0)}%`);

    const nativeSuccessRate = (nativeResults.filter(r => r.success).length / nativeResults.length) * 100;
    console.log(`native-grep   | ${nativeStats.avg.toFixed(1).padStart(8)} | ${nativeStats.min.toFixed(1).padStart(8)} | ${nativeStats.max.toFixed(1).padStart(8)} | ${nativeStats.p50.toFixed(1).padStart(8)} | ${nativeStats.p95.toFixed(1).padStart(8)} | ${nativeStats.p99.toFixed(1).padStart(8)} | ${nativeStats.avgMatchCount.toFixed(1).padStart(11)} | ${nativeSuccessRate.toFixed(0)}%`);

    console.log("\n\nCOMPARISON");
    console.log("----------");
    console.log(`grep-bash:   ${bashStats.avg.toFixed(1)} ms (avg ${bashStats.avgMatchCount.toFixed(1)} matches)`);
    console.log(`ripgrep:     ${rgStats.avg.toFixed(1)} ms (avg ${rgStats.avgMatchCount.toFixed(1)} matches)`);
    console.log(`native-grep: ${nativeStats.avg.toFixed(1)} ms (avg ${nativeStats.avgMatchCount.toFixed(1)} matches)`);

    const times = [
      { method: 'grep-bash', avg: bashStats.avg },
      { method: 'ripgrep', avg: rgStats.avg },
      { method: 'native-grep', avg: nativeStats.avg },
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

