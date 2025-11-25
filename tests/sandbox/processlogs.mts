import { SandboxInstance } from "@blaxel/core";

const sandbox = await SandboxInstance.create();

console.log("sandbox created => ", sandbox.metadata!.name)

const BATCH_SIZE = 20;
const TOTAL_EXECUTIONS = 200; // N number of times
const NUM_BATCHES = Math.ceil(TOTAL_EXECUTIONS / BATCH_SIZE);

// Store logs collected via onLog callback for comparison
const onLogCollected = new Map<number, string[]>();

// Store results for analysis
interface ProcessResult {
  index: number;
  success: boolean;
  error?: string;
  onLogLogs: string;
  resultLogs: string;
  missingExpected?: string[];
  logsMismatch: boolean;
}

const results: ProcessResult[] = [];

async function executeProcess(index: number): Promise<ProcessResult> {
  // Initialize array to collect logs from onLog callback
  onLogCollected.set(index, []);

  try {
    const result = await sandbox.process.exec({
      command: 'echo "hello" && ls /nonexistent 2>&1',
      waitForCompletion: true,
      workingDir: '/agent',  // FUSE mount
      name: `process-${index}`,
      onLog: (log) => {
        onLogCollected.get(index)?.push(log);
      },
    });

    // Get the logs from onLog callback
    const collectedLogs = onLogCollected.get(index)?.join('') || '';
    const resultLogs = result.logs || '';

    // Sanitize logs for comparison (remove newlines)
    const sanitize = (str: string) => str.replace(/\n/g, '');
    const sanitizedCollectedLogs = sanitize(collectedLogs);
    const sanitizedResultLogs = sanitize(resultLogs);

    // Verify result.logs contains expected output
    const expectedOutputs = [
      'hello',
      'ls: /nonexistent: No such file or directory'
    ];

    const missingExpected: string[] = [];
    for (const expected of expectedOutputs) {
      if (!sanitizedResultLogs.includes(expected)) {
        missingExpected.push(expected);
      }
    }

    // Compare onLog collected logs with result.logs (sanitized)
    const logsMismatch = sanitizedCollectedLogs !== sanitizedResultLogs;

    const processResult: ProcessResult = {
      index,
      success: missingExpected.length === 0 && !logsMismatch,
      onLogLogs: collectedLogs,
      resultLogs: resultLogs,
      missingExpected: missingExpected.length > 0 ? missingExpected : undefined,
      logsMismatch,
    };

    return processResult;
  } catch (error) {
    return {
      index,
      success: false,
      error: String(error),
      onLogLogs: onLogCollected.get(index)?.join('') || '',
      resultLogs: '',
      logsMismatch: false,
    };
  }
}

console.log(`Starting ${TOTAL_EXECUTIONS} executions in ${NUM_BATCHES} batches of ${BATCH_SIZE}...`);

const batchTimings: number[] = [];
const overallStart = Date.now();

// Execute in batches
for (let batchIndex = 0; batchIndex < NUM_BATCHES; batchIndex++) {
  const startIndex = batchIndex * BATCH_SIZE;
  const endIndex = Math.min(startIndex + BATCH_SIZE, TOTAL_EXECUTIONS);

  process.stdout.write(`\rProcessing batch ${batchIndex + 1}/${NUM_BATCHES}...`);

  const batchPromises: Promise<ProcessResult>[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    batchPromises.push(executeProcess(i));
  }

  const batchStart = Date.now();
  const batchResults = await Promise.all(batchPromises);
  const batchDuration = Date.now() - batchStart;

  batchTimings.push(batchDuration);
  results.push(...batchResults);
}

const overallDuration = Date.now() - overallStart;
console.log(`\r✅ All executions completed in ${overallDuration}ms\n`);

// Analyze results
console.log('='.repeat(80));
console.log('ANALYSIS REPORT');
console.log('='.repeat(80));

const successfulProcesses = results.filter(r => r.success);
const failedProcesses = results.filter(r => !r.success);

console.log(`\n📊 Overall Statistics:`);
console.log(`   Total processes:     ${TOTAL_EXECUTIONS}`);
console.log(`   Successful:          ${successfulProcesses.length} (${(successfulProcesses.length / TOTAL_EXECUTIONS * 100).toFixed(1)}%)`);
console.log(`   Failed:              ${failedProcesses.length} (${(failedProcesses.length / TOTAL_EXECUTIONS * 100).toFixed(1)}%)`);
console.log(`   Total duration:      ${overallDuration}ms`);
console.log(`   Average per batch:   ${(batchTimings.reduce((a, b) => a + b, 0) / batchTimings.length).toFixed(0)}ms`);
console.log(`   Fastest batch:       ${Math.min(...batchTimings)}ms`);
console.log(`   Slowest batch:       ${Math.max(...batchTimings)}ms`);

if (failedProcesses.length > 0) {
  console.log(`\n❌ Failed Processes (${failedProcesses.length}):`);

  // Group failures by type
  const withErrors = failedProcesses.filter(r => r.error);
  const withMissingExpected = failedProcesses.filter(r => r.missingExpected && r.missingExpected.length > 0);
  const withLogsMismatch = failedProcesses.filter(r => r.logsMismatch);

  if (withErrors.length > 0) {
    console.log(`\n   Execution Errors (${withErrors.length}):`);
    withErrors.forEach(r => {
      console.log(`      Process ${r.index}: ${r.error}`);
    });
  }

  if (withMissingExpected.length > 0) {
    console.log(`\n   Missing Expected Output (${withMissingExpected.length}):`);
    withMissingExpected.forEach(r => {
      console.log(`      Process ${r.index}:`);
      r.missingExpected?.forEach(expected => {
        console.log(`         - Missing: "${expected}"`);
      });
      console.log(`         - Actual: "${r.resultLogs}"`);
    });
  }

  if (withLogsMismatch.length > 0) {
    console.log(`\n   Logs Mismatch (${withLogsMismatch.length}):`);
    withLogsMismatch.forEach(r => {
      const sanitize = (str: string) => str.replace(/\n/g, '');
      console.log(`      Process ${r.index}:`);
      console.log(`         onLog (sanitized):  "${sanitize(r.onLogLogs)}"`);
      console.log(`         result (sanitized): "${sanitize(r.resultLogs)}"`);
      console.log(`         onLog (raw):  ${JSON.stringify(r.onLogLogs)}`);
      console.log(`         result (raw): ${JSON.stringify(r.resultLogs)}`);
    });
  }
} else {
  console.log(`\n✅ All processes completed successfully!`);
  console.log(`\n   Sample output (Process 0):`);
  console.log(`   ${results[0].resultLogs.split('\n').join('\n   ')}`);
}

console.log('\n' + '='.repeat(80));
await SandboxInstance.delete(sandbox.metadata!.name!)
