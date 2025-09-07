import { SandboxInstance, VolumeInstance, settings } from "@blaxel/core";

// Helper function to measure execution time
async function measureTime<T>(
    name: string,
    fn: () => Promise<T>
): Promise<{ name: string; duration: number; result?: T; error?: any }> {
    const start = performance.now();
    try {
        const result = await fn();
        const duration = performance.now() - start;
        return { name, duration, result };
    } catch (error) {
        const duration = performance.now() - start;
        return { name, duration, error };
    }
}

// Helper function to run multiple iterations and calculate statistics
async function runBenchmark(
    name: string,
    fn: () => Promise<any>,
    iterations: number = 5,
    silent: boolean = false
): Promise<{
    name: string;
    iterations: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
    totalTime: number;
    times: number[];
}> {
    const times: number[] = [];
    let totalTime = 0;

    if (!silent) {
        console.log(`\n📊 Running benchmark: ${name}`);
        console.log(`   Iterations: ${iterations}`);
    }

    for (let i = 0; i < iterations; i++) {
        const result = await measureTime(`${name} #${i + 1}`, fn);
        times.push(result.duration);
        totalTime += result.duration;
        if (!silent) {
            console.log(`   Run #${i + 1}: ${result.duration.toFixed(2)}ms`);
        }
        
        // Small delay between iterations to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const avgTime = totalTime / iterations;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    return {
        name,
        iterations,
        avgTime,
        minTime,
        maxTime,
        totalTime,
        times
    };
}

async function runBenchmarkSuite(sandboxName: string, gwGeneration: string | null, silent: boolean = false): Promise<any[]> {
    if (!silent) {
        console.log(`\n🚀 Running benchmarks with GW generation: ${gwGeneration || 'default'}`);
        console.log("=============================================");
    }

    // Create or get sandbox instance
    const sandbox = await SandboxInstance.createIfNotExists({
        name: sandboxName,
        image: "blaxel/dev-nextjs:latest",
    });
    
    // Prepare test data
    const testFilePath = `/tmp/benchmark-test-${Date.now()}.txt`;
    const testContent = "This is a benchmark test file content. ".repeat(100); // ~4KB of data
    const testDir = `/tmp/benchmark-dir-${Date.now()}`;
    const largeContent = "Large file content for benchmark testing. ".repeat(1000); // ~43KB of data

    // Setup: Write test files
    if (!silent) console.log("\n📁 Setting up test environment...");
    await sandbox.fs.write(testFilePath, testContent);
    await sandbox.fs.write(`/tmp/large-file-${Date.now()}.txt`, largeContent);
    await sandbox.fs.mkdir(testDir);
    
    // Create some files in the test directory
    for (let i = 0; i < 5; i++) {
        await sandbox.fs.write(`${testDir}/file-${i}.txt`, `Test file ${i}`);
    }

    const benchmarks: any[] = [];

    // Benchmark 1: Small File Read
    benchmarks.push(await runBenchmark(
        "Small File Read (~4KB)",
        async () => await sandbox.fs.read(testFilePath),
        5,
        silent
    ));

    // Benchmark 2: File Write
    benchmarks.push(await runBenchmark(
        "File Write (~4KB)",
        async () => await sandbox.fs.write(`${testDir}/write-${Date.now()}.txt`, testContent),
        5,
        silent
    ));

    // Benchmark 3: Directory Listing
    benchmarks.push(await runBenchmark(
        "Directory List (5 files)",
        async () => await sandbox.fs.ls(testDir),
        5,
        silent
    ));

    // Benchmark 4: File Copy
    benchmarks.push(await runBenchmark(
        "File Copy",
        async () => {
            const source = testFilePath;
            const dest = `${testDir}/copy-${Date.now()}.txt`;
            return await sandbox.fs.cp(source, dest);
        },
        5,
        silent
    ));

    // Benchmark 5: Directory Creation
    benchmarks.push(await runBenchmark(
        "Directory Creation",
        async () => await sandbox.fs.mkdir(`${testDir}/subdir-${Date.now()}`),
        5,
        silent
    ));

    // Benchmark 6: Simple Process Execution
    benchmarks.push(await runBenchmark(
        "Process Exec (echo)",
        async () => await sandbox.process.exec({
            command: "echo Hello from benchmark",
            waitForCompletion: true
        }),
        3,
        silent
    ));

    // Benchmark 7: Process List
    benchmarks.push(await runBenchmark(
        "Process List",
        async () => await sandbox.process.list(),
        3,
        silent
    ));

    // Cleanup
    if (!silent) console.log("\n🧹 Cleaning up test files...");
    try {
        await sandbox.fs.rm(testDir, true);
        await sandbox.fs.rm(testFilePath);
    } catch (e) {
        // Ignore cleanup errors
    }

    return benchmarks;
}

async function main() {
    console.log("🔬 GW GENERATION COMPARISON BENCHMARK");
    console.log("=======================================");
    console.log("Comparing performance between GW generations\n");

    // Store original env var value
    const originalGwGen = process.env.GW_GENERATION;

    // Run benchmarks WITHOUT v2
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📦 CONFIGURATION 1: Default GW Generation");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    delete process.env.GW_GENERATION;
    const defaultResults = await runBenchmarkSuite("benchmark-default", null);

    // Wait a bit between test suites
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Run benchmarks WITH v2
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚀 CONFIGURATION 2: V2 GW Generation");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    process.env.GW_GENERATION = 'v2';
    const v2Results = await runBenchmarkSuite("benchmark-v2", 'v2');

    // Restore original env var
    if (originalGwGen !== undefined) {
        process.env.GW_GENERATION = originalGwGen;
    } else {
        delete process.env.GW_GENERATION;
    }

    // Print comparison report
    console.log("\n\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 PERFORMANCE COMPARISON REPORT");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // Create comparison table
    console.log("| Operation               | Default (ms) | V2 (ms)     | Diff (ms)   | Change %    | Faster      |");
    console.log("|-------------------------|--------------|-------------|-------------|-------------|-------------|");

    let totalDefaultTime = 0;
    let totalV2Time = 0;

    for (let i = 0; i < defaultResults.length; i++) {
        const defaultBench = defaultResults[i];
        const v2Bench = v2Results[i];
        
        totalDefaultTime += defaultBench.avgTime;
        totalV2Time += v2Bench.avgTime;
        
        const diff = v2Bench.avgTime - defaultBench.avgTime;
        const percentChange = ((diff / defaultBench.avgTime) * 100).toFixed(1);
        const faster = diff > 0 ? "Default ✅" : "V2 ✅";
        const changeSymbol = diff > 0 ? "+" : "";
        
        console.log(
            `| ${defaultBench.name.padEnd(23)} | ${
                defaultBench.avgTime.toFixed(2).padStart(12)
            } | ${
                v2Bench.avgTime.toFixed(2).padStart(11)
            } | ${
                (changeSymbol + diff.toFixed(2)).padStart(11)
            } | ${
                (changeSymbol + percentChange + "%").padStart(11)
            } | ${
                faster.padStart(11)
            } |`
        );
    }

    console.log("|-------------------------|--------------|-------------|-------------|-------------|-------------|");
    
    // Overall comparison
    const totalDiff = totalV2Time - totalDefaultTime;
    const totalPercentChange = ((totalDiff / totalDefaultTime) * 100).toFixed(1);
    const overallFaster = totalDiff > 0 ? "Default" : "V2";
    const changeSymbol = totalDiff > 0 ? "+" : "";
    
    console.log(
        `| ${"TOTAL".padEnd(23)} | ${
            totalDefaultTime.toFixed(2).padStart(12)
        } | ${
            totalV2Time.toFixed(2).padStart(11)
        } | ${
            (changeSymbol + totalDiff.toFixed(2)).padStart(11)
        } | ${
            (changeSymbol + totalPercentChange + "%").padStart(11)
        } | ${
            (overallFaster + " ✅").padStart(11)
        } |`
    );

    console.log("\n📈 Summary Analysis:");
    console.log("====================");
    console.log(`• Default GW Generation avg total: ${totalDefaultTime.toFixed(2)}ms`);
    console.log(`• V2 GW Generation avg total: ${totalV2Time.toFixed(2)}ms`);
    console.log(`• Overall difference: ${Math.abs(totalDiff).toFixed(2)}ms (${Math.abs(parseFloat(totalPercentChange))}%)`);
    console.log(`• ⚡ ${overallFaster} GW generation is faster overall`);

    // Detailed operation analysis
    console.log("\n📊 Operation-Specific Analysis:");
    console.log("================================");
    
    const fileOps = defaultResults.filter((_, i) => 
        defaultResults[i].name.includes("File") || defaultResults[i].name.includes("Directory")
    );
    const processOps = defaultResults.filter((_, i) => 
        defaultResults[i].name.includes("Process")
    );

    // File operations comparison
    if (fileOps.length > 0) {
        console.log("\n📁 File System Operations:");
        const fileIndices = defaultResults
            .map((b, i) => (b.name.includes("File") || b.name.includes("Directory")) ? i : -1)
            .filter(i => i >= 0);
        
        let defaultFileTotal = 0;
        let v2FileTotal = 0;
        
        fileIndices.forEach(i => {
            defaultFileTotal += defaultResults[i].avgTime;
            v2FileTotal += v2Results[i].avgTime;
        });
        
        const fileDiff = v2FileTotal - defaultFileTotal;
        const filePercent = ((fileDiff / defaultFileTotal) * 100).toFixed(1);
        const fileFaster = fileDiff > 0 ? "Default" : "V2";
        
        console.log(`   Default avg: ${(defaultFileTotal / fileIndices.length).toFixed(2)}ms`);
        console.log(`   V2 avg: ${(v2FileTotal / fileIndices.length).toFixed(2)}ms`);
        console.log(`   ${fileFaster} is ${Math.abs(parseFloat(filePercent))}% faster for file operations`);
    }

    // Process operations comparison
    if (processOps.length > 0) {
        console.log("\n⚙️  Process Operations:");
        const processIndices = defaultResults
            .map((b, i) => b.name.includes("Process") ? i : -1)
            .filter(i => i >= 0);
        
        let defaultProcessTotal = 0;
        let v2ProcessTotal = 0;
        
        processIndices.forEach(i => {
            defaultProcessTotal += defaultResults[i].avgTime;
            v2ProcessTotal += v2Results[i].avgTime;
        });
        
        const processDiff = v2ProcessTotal - defaultProcessTotal;
        const processPercent = ((processDiff / defaultProcessTotal) * 100).toFixed(1);
        const processFaster = processDiff > 0 ? "Default" : "V2";
        
        console.log(`   Default avg: ${(defaultProcessTotal / processIndices.length).toFixed(2)}ms`);
        console.log(`   V2 avg: ${(v2ProcessTotal / processIndices.length).toFixed(2)}ms`);
        console.log(`   ${processFaster} is ${Math.abs(parseFloat(processPercent))}% faster for process operations`);
    }

    console.log("\n✅ GW generation comparison benchmark completed!");

    // Clean up sandboxes
    console.log("\n🗑️  Cleaning up sandboxes...");
    try {
        await SandboxInstance.delete("benchmark-default");
        console.log("   ✓ Deleted sandbox: benchmark-default");
    } catch (e) {
        console.log("   ⚠ Could not delete sandbox benchmark-default:", e);
    }
    
    try {
        await SandboxInstance.delete("benchmark-v2");
        console.log("   ✓ Deleted sandbox: benchmark-v2");
    } catch (e) {
        console.log("   ⚠ Could not delete sandbox benchmark-v2:", e);
    }
    
    console.log("\n🎉 All done! Sandboxes and test files have been cleaned up.");
}

// Run with error handling
main().catch(error => {
    console.error("❌ Benchmark failed:", error);
    process.exit(1);
});