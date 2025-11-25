import { SandboxInstance } from "@blaxel/core";

// Global type for tracking first run
declare global {
  var benchFuzzySearchFirstRun: boolean | undefined;
  var benchFindFirstRun: boolean | undefined;
}

// ============ CONFIGURATION ============
const ITERATIONS_PER_TEST = 20; // Number of iterations for each test
const WARMUP_ITERATIONS = 3; // Warmup iterations before actual measurements
const SANDBOX_NAME = "fzf-test"; // Existing sandbox to connect to
const SETUP_ENVIRONMENT = true; // Set to false to skip environment setup if already exists
// =======================================

interface BenchResult {
  operation: string;
  method: 'fzf' | 'native-search' | 'find-bash' | 'native-find';
  iteration: number;
  duration: number;
  success: boolean;
  error?: string;
}

interface OperationStats {
  operation: string;
  method: 'fzf' | 'native-search' | 'find-bash' | 'native-find';
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  successRate: number;
}

function calculateStats(results: BenchResult[]): OperationStats {
  const successfulResults = results.filter(r => r.success);
  const durations = successfulResults.map(r => r.duration).sort((a, b) => a - b);

  const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const min = durations[0] || 0;
  const max = durations[durations.length - 1] || 0;
  const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
  const p99 = durations[Math.floor(durations.length * 0.99)] || 0;
  const successRate = (successfulResults.length / results.length) * 100;

  return {
    operation: results[0]?.operation || 'unknown',
    method: results[0]?.method || 'native',
    avg,
    min,
    max,
    p50,
    p95,
    p99,
    successRate,
  };
}

async function setupTestEnvironment(sandbox: SandboxInstance): Promise<void> {
  console.log("📦 Setting up test environment...");

  // Clone the vite-template repository
  console.log("  Cloning vite-template repository...");
  await sandbox.process.exec({
    command: "git clone https://github.com/relace-ai/vite-template.git /workspace/repo"
  });

  console.log("✓ Test environment ready (repository cloned)");
}

// ============ BENCHMARK OPERATIONS ============

async function benchFuzzySearch(sandbox: SandboxInstance, method: 'fzf' | 'native-search'): Promise<number> {
  const start = Date.now();
  let fileCount = 0;

  if (method === 'native-search') {
    const result = await sandbox.fs.search(
      "components.json",
      "/workspace/repo/",
      {
        // patterns: ['*.json'],
        maxResults: 100,
        excludeHidden: false
      }
    );
    fileCount = result.matches?.length || 0;
  } else if (method === 'fzf') {
    const result = await sandbox.process.exec({
      command: 'find /workspace/repo/ -type f | fzf -e -f "components.json"',
      waitForCompletion: true,
    });
    const output = result.logs || "";
    const lines = output.trim().split('\n').filter(l => l);
    fileCount = lines.length;
  }

  const duration = Date.now() - start;

  if (global.benchFuzzySearchFirstRun === undefined) {
    console.log(`    📊 Files found: ${fileCount}`);
    global.benchFuzzySearchFirstRun = true;
  }

  return duration;
}

async function benchFind(sandbox: SandboxInstance, method: 'find-bash' | 'native-find'): Promise<number> {
  const start = Date.now();
  let fileCount = 0;

  if (method === 'native-find') {
    const result = await sandbox.fs.find(
      "/workspace/repo/",
      {
        type: 'file',
        patterns: ['*.json'],
        maxResults: 100,
        excludeHidden: true,
      }
    );
    fileCount = result.matches?.length || 0;
  } else {
    const result = await sandbox.process.exec({
      command: 'find /workspace/repo/ -type f -name "*.json" | head -100',
      waitForCompletion: true,
    });
    const output = result.logs || "";
    const lines = output.trim().split('\n').filter(l => l);
    fileCount = lines.length;
  }

  const duration = Date.now() - start;

  if (global.benchFindFirstRun === undefined) {
    console.log(`    📊 Files found: ${fileCount}`);
    global.benchFindFirstRun = true;
  }

  return duration;
}

// ============ BENCHMARK RUNNER ============

async function runBenchmark(
  name: string,
  operation: string,
  benchFn: (sandbox: SandboxInstance, method: any) => Promise<number>,
  sandbox: SandboxInstance,
  method: 'fzf' | 'native-search' | 'find-bash' | 'native-find'
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  console.log(`\n  Running: ${operation} (${method})...`);

  // Warmup
  console.log(`    Warmup (${WARMUP_ITERATIONS} iterations)...`);
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    try {
      await benchFn(sandbox, method);
    } catch (error) {
      console.log(`    ⚠ Warmup ${i + 1} failed`);
    }
  }

  // Actual benchmark
  console.log(`    Measuring (${ITERATIONS_PER_TEST} iterations)...`);
  for (let i = 0; i < ITERATIONS_PER_TEST; i++) {
    try {
      const duration = await benchFn(sandbox, method);
      results.push({
        operation,
        method,
        iteration: i + 1,
        duration,
        success: true,
      });

      // Progress indicator every 5 iterations
      if ((i + 1) % 5 === 0) {
        console.log(`    Progress: ${i + 1}/${ITERATIONS_PER_TEST}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({
        operation,
        method,
        iteration: i + 1,
        duration: 0,
        success: false,
        error: errorMsg,
      });
      console.log(`    ❌ Iteration ${i + 1} failed: ${errorMsg}`);
    }
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`    ✓ Complete: ${successCount}/${ITERATIONS_PER_TEST} successful`);

  return results;
}

async function main() {
  console.log("========================================");
  console.log("  FIND vs FZF vs NATIVE SEARCH");
  console.log("  BENCHMARK SUITE");
  console.log("========================================");
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Sandbox: ${SANDBOX_NAME}`);
  console.log(`   Iterations per test: ${ITERATIONS_PER_TEST}`);
  console.log(`   Warmup iterations: ${WARMUP_ITERATIONS}`);
  console.log(`   Setup environment: ${SETUP_ENVIRONMENT}\n`);

  let sandbox: SandboxInstance | null = null;

  try {
    // Connect to existing sandbox
    console.log(`🔗 Connecting to sandbox: ${SANDBOX_NAME}...`);
    sandbox = await SandboxInstance.get(SANDBOX_NAME);
    console.log(`✓ Connected to sandbox: ${sandbox.metadata?.name || 'unknown'}`);

    // Setup test environment (optional)
    if (SETUP_ENVIRONMENT) {
      try {
        console.log("📦 Setting up test environment...");
        await setupTestEnvironment(sandbox);
      } catch (error) {
        console.log("⚠️  Test environment setup failed (may already exist):", error instanceof Error ? error.message : String(error));
      }
    }

    // Validate FUZZY SEARCH: fzf vs native search
    console.log("\n🔍 Validating FUZZY SEARCH (components.json)...");
    try {
      const fzfResult = await sandbox.process.exec({
        command: 'find /workspace/repo/ -type f | fzf -e -f "components.json"',
        waitForCompletion: true,
      });
      const fzfLines = (fzfResult.logs || "").trim().split('\n').filter(l => l);
      console.log(`   fzf:           Found ${fzfLines.length} files`);
      fzfLines.slice(0, 3).forEach(f => console.log(`                  - ${f}`));

      const nativeSearchResult = await sandbox.fs.search(
        "",
        "/workspace/repo",
        {
          patterns: ['*.json'],
          maxResults: 100,
          excludeHidden: false
        }
      );
      console.log(`   native-search: Found ${nativeSearchResult.matches?.length || 0} files`);
      nativeSearchResult.matches?.slice(0, 3).forEach(m => console.log(`                  - ${m.path}`));

    } catch (error) {
      console.log(`   ⚠️  Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Validate FIND: bash find vs native find
    console.log("\n🔍 Validating FIND (*.json from /)...");
    try {
      const findBashResult = await sandbox.process.exec({
        command: 'find /workspace/repo/ -type f -name "*.json" | head -100',
        waitForCompletion: true,
      });
      const bashLines = (findBashResult.logs || "").trim().split('\n').filter(l => l);
      console.log(`   find-bash:   Found ${bashLines.length} files`);
      bashLines.slice(0, 3).forEach(f => console.log(`                - ${f}`));

      const findNativeResult = await sandbox.fs.find(
        "/workspace/repo/",
        {
          type: 'file',
          patterns: ['*.json'],
          maxResults: 100,
          excludeHidden: true,
        }
      );
      console.log(`   native-find: Found ${findNativeResult.matches?.length || 0} matches`);
      findNativeResult.matches?.slice(0, 3).forEach(m => console.log(`                - ${m.path} (type: ${m.type})`));

    } catch (error) {
      console.log(`   ⚠️  Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const allResults: BenchResult[] = [];

    // Define benchmarks
    const searchBenchmarks: Array<{
      name: string;
      operation: string;
      fn: (sandbox: SandboxInstance, method: 'fzf' | 'native-search') => Promise<number>;
      methods: Array<'fzf' | 'native-search'>;
    }> = [
      {
        name: "Fuzzy Search: components.json",
        operation: "fuzzy_search",
        fn: benchFuzzySearch,
        methods: ['fzf', 'native-search'],
      },
    ];

    const findBenchmarks: Array<{
      name: string;
      operation: string;
      fn: (sandbox: SandboxInstance, method: 'find-bash' | 'native-find') => Promise<number>;
      methods: Array<'find-bash' | 'native-find'>;
    }> = [
      {
        name: "Find: All .json files from /",
        operation: "find_json_files",
        fn: benchFind,
        methods: ['find-bash', 'native-find'],
      },
    ];

    // Run search benchmarks
    for (const benchmark of searchBenchmarks) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📊 Benchmark: ${benchmark.name}`);

      for (const method of benchmark.methods) {
        const results = await runBenchmark(
          benchmark.name,
          benchmark.operation,
          benchmark.fn,
          sandbox,
          method
        );
        allResults.push(...results);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Run find benchmarks
    for (const benchmark of findBenchmarks) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📊 Benchmark: ${benchmark.name}`);

      for (const method of benchmark.methods) {
        const results = await runBenchmark(
          benchmark.name,
          benchmark.operation,
          benchmark.fn,
          sandbox,
          method
        );
        allResults.push(...results);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Calculate and display results
    console.log("\n\n========================================");
    console.log("           BENCHMARK RESULTS");
    console.log("========================================\n");

    // Group results by operation and method
    const resultsByOperation = new Map<string, Map<string, BenchResult[]>>();
    for (const result of allResults) {
      if (!resultsByOperation.has(result.operation)) {
        resultsByOperation.set(result.operation, new Map());
      }
      const operationMap = resultsByOperation.get(result.operation)!;
      if (!operationMap.has(result.method)) {
        operationMap.set(result.method, []);
      }
      operationMap.get(result.method)!.push(result);
    }

    // Print detailed statistics table
    console.log("DETAILED STATISTICS");
    console.log("-------------------\n");

    for (const [operation, methodsMap] of resultsByOperation) {
      console.log(`\n${operation.replace(/_/g, ' ').toUpperCase()}`);
      console.log("Method        | Avg (ms) | Min (ms) | Max (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Success");
      console.log("--------------|----------|----------|----------|----------|----------|----------|---------");

      const allStats: Array<{ method: string, stats: OperationStats }> = [];

      for (const [method, results] of methodsMap) {
        if (results.length > 0) {
          const stats = calculateStats(results);
          allStats.push({ method, stats });
        }
      }

      for (const { method, stats } of allStats) {
        const methodName = method.padEnd(13);
        const avg = stats.avg.toFixed(1).padStart(8);
        const min = stats.min.toFixed(1).padStart(8);
        const max = stats.max.toFixed(1).padStart(8);
        const p50 = stats.p50.toFixed(1).padStart(8);
        const p95 = stats.p95.toFixed(1).padStart(8);
        const p99 = stats.p99.toFixed(1).padStart(8);
        const success = `${stats.successRate.toFixed(0)}%`.padStart(7);
        console.log(`${methodName} | ${avg} | ${min} | ${max} | ${p50} | ${p95} | ${p99} | ${success}`);
      }

      // Find fastest for this operation
      if (allStats.length > 0) {
        const sorted = allStats.sort((a, b) => a.stats.avg - b.stats.avg);
        console.log(`\n  Fastest: ${sorted[0].method} (${sorted[0].stats.avg.toFixed(1)} ms)`);
      }
    }

    console.log("\n========================================\n");

  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    throw error;
  }

  console.log(`\n💾 Sandbox '${SANDBOX_NAME}' remains available for further testing.`);
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});

