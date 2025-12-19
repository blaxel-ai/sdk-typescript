import { authenticate, settings } from "@blaxel/core";
import http2 from "http2";

const BL_ENV = process.env.BL_ENV || "prod";
const BL_REGION = process.env.BL_REGION || (BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1");
const API_BASE_URL = BL_ENV === "prod" ? "https://api.blaxel.ai/v0" : "https://api.blaxel.dev/v0";

interface HealthCheckResult {
  sandboxName: string;
  sandboxCreationTime: number;
  healthCheckTime: number;
  availabilityGap: number;
  totalTime: number;
  success: boolean;
  httpStatus?: number;
  error?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

// Create HTTP/2 session pool
const http2Sessions = new Map<string, http2.ClientHttp2Session>();

function getHttp2Session(url: string): http2.ClientHttp2Session {
  const urlObj = new URL(url);
  const origin = `${urlObj.protocol}//${urlObj.host}`;

  let session = http2Sessions.get(origin);
  if (!session || session.destroyed || session.closed) {
    session = http2.connect(origin);
    http2Sessions.set(origin, session);

    session.on('error', (err) => {
      console.error(`HTTP/2 session error for ${origin}:`, err);
      http2Sessions.delete(origin);
    });
  }

  return session;
}

async function http2Request(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const session = getHttp2Session(url);

    const headers = {
      ':method': options.method,
      ':path': urlObj.pathname + urlObj.search,
      ...options.headers,
    };

    const req = session.request(headers);

    let responseData = '';
    let responseHeaders: Record<string, string> = {};
    let statusCode = 0;

    req.on('response', (headers) => {
      statusCode = Number(headers[':status']);
      Object.entries(headers).forEach(([key, value]) => {
        if (!key.startsWith(':')) {
          responseHeaders[key] = String(value);
        }
      });
    });

    req.on('data', (chunk) => {
      responseData += chunk.toString();
    });

    req.on('end', () => {
      resolve({
        status: statusCode,
        headers: responseHeaders,
        body: responseData,
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function createSandbox(sandboxName: string): Promise<{ url: string; creationTime: number }> {
  const startTime = Date.now();

  const body = JSON.stringify({
    metadata: {
      name: sandboxName,
    },
    spec: {
      runtime: {
        image: "blaxel/base-image:latest",
        ports: [
          {
            name: "sandbox-api",
            target: 8080,
            protocol: "HTTP"
          }
        ],
        generation: "mk3",
        memory: 4096,
      },
      region: BL_REGION,
    }
  });

  const response = await http2Request(`${API_BASE_URL}/sandboxes?workspace=${settings.workspace}`, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-blaxel-authorization': settings.authorization,
      'x-blaxel-workspace': settings.workspace,
      'user-agent': settings.headers['User-Agent'],
    },
    body,
  });

  const creationTime = Date.now() - startTime;

  if (response.status >= 400) {
    throw new Error(`Failed to create sandbox: HTTP ${response.status} - ${response.body}`);
  }

  const data = JSON.parse(response.body);
  const sandboxUrl = data.metadata?.url;

  if (!sandboxUrl) {
    throw new Error('No sandbox URL in response');
  }

  return { url: sandboxUrl, creationTime };
}

async function deleteSandbox(sandboxName: string): Promise<void> {
  await http2Request(`${API_BASE_URL}/sandboxes/${sandboxName}?workspace=${settings.workspace}`, {
    method: 'DELETE',
    headers: {
      'accept': 'application/json',
      'x-blaxel-authorization': settings.authorization,
      'x-blaxel-workspace': settings.workspace,
      'user-agent': settings.headers['User-Agent'],
    },
  });
}

async function runHealthCheck(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const randomSandboxName = `sandbox-health-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    // Create sandbox using HTTP/2
    const { url: sandboxHost, creationTime: sandboxCreationTime } = await createSandbox(randomSandboxName);

    // Immediately call the health endpoint
    const healthCheckStartTime = Date.now();

    const healthResponse = await http2Request(`${sandboxHost}/health`, {
      method: 'GET',
      headers: {
        'authorization': settings.authorization,
        'user-agent': settings.headers['User-Agent'],
      },
    });

    const healthCheckTime = Date.now() - healthCheckStartTime;
    const availabilityGap = Date.now() - (startTime + sandboxCreationTime);
    const totalTime = Date.now() - startTime;

    // Check the status code - catch all 400+ errors
    if (healthResponse.status >= 400) {
      const errorMessage = `HTTP ${healthResponse.status}`;

      // Clean up before returning error
      await deleteSandbox(randomSandboxName).catch(() => {});

      return {
        sandboxName: randomSandboxName,
        sandboxCreationTime,
        healthCheckTime,
        availabilityGap,
        totalTime,
        success: false,
        httpStatus: healthResponse.status,
        error: errorMessage,
        responseHeaders: healthResponse.headers,
        responseBody: healthResponse.body,
      };
    }

    // Try to parse the JSON response
    let healthData;
    try {
      healthData = JSON.parse(healthResponse.body);
    } catch (parseError) {
      // Clean up before returning error
      await deleteSandbox(randomSandboxName).catch(() => {});

      return {
        sandboxName: randomSandboxName,
        sandboxCreationTime,
        healthCheckTime,
        availabilityGap,
        totalTime,
        success: false,
        httpStatus: healthResponse.status,
        error: "Failed to parse JSON response",
      };
    }

    // Clean up
    await deleteSandbox(randomSandboxName).catch(() => {
      // Ignore cleanup errors
    });

    return {
      sandboxName: randomSandboxName,
      sandboxCreationTime,
      healthCheckTime,
      availabilityGap,
      totalTime,
      success: true,
      httpStatus: healthResponse.status,
    };
  } catch (error: any) {
    // Try to clean up on error
    try {
      await deleteSandbox(randomSandboxName).catch(() => {});
    } catch {}

    // Better error serialization
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = `${error.name}: ${error.message}`;
    } else if (typeof error === 'object' && error !== null) {
      const errorInfo: any = {
        message: error.message,
        code: error.code,
        status: error.status,
      };
      Object.keys(errorInfo).forEach(key => {
        if (errorInfo[key] === undefined || errorInfo[key] === null) {
          delete errorInfo[key];
        }
      });
      errorMessage = JSON.stringify(errorInfo, null, 2);
    } else {
      errorMessage = String(error);
    }

    return {
      sandboxName: randomSandboxName,
      sandboxCreationTime: 0,
      healthCheckTime: 0,
      availabilityGap: 0,
      totalTime: Date.now() - startTime,
      success: false,
      error: errorMessage,
      httpStatus: error?.status || error?.statusCode,
    };
  }
}

async function main() {
  await authenticate();
  // Get parameters from command line or environment
  const numChecks = parseInt(process.argv[2] || process.env.NUM_CHECKS || "1", 10);
  const parallelism = parseInt(process.argv[3] || process.env.PARALLELISM || "1", 10);

  console.log(`Running ${numChecks} health check(s) with parallelism of ${parallelism}`);
  console.log(`Environment: ${BL_ENV}`);
  console.log(`Region: ${BL_REGION}`);
  console.log(`Using: Native HTTP/2 (node:http2)`);
  console.log("---");

  const results: HealthCheckResult[] = [];

  // Run health checks with specified parallelism
  for (let i = 0; i < numChecks; i += parallelism) {
    const batch = Math.min(parallelism, numChecks - i);
    const promises = Array.from({ length: batch }, () => runHealthCheck());

    console.log(`Running batch ${Math.floor(i / parallelism) + 1}/${Math.ceil(numChecks / parallelism)} (${batch} parallel check(s))...`);
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // Log individual results
    batchResults.forEach((result, idx) => {
      const checkNum = i + idx + 1;
      if (result.success) {
        console.log(`  [${checkNum}] ✓ ${result.sandboxName}`);
        console.log(`      Sandbox creation: ${result.sandboxCreationTime}ms`);
        console.log(`      Health check: ${result.healthCheckTime}ms (HTTP ${result.httpStatus})`);
        console.log(`      Availability gap: ${result.availabilityGap}ms`);
        console.log(`      Total: ${result.totalTime}ms`);
      } else {
        console.log(`  [${checkNum}] ✗ ${result.sandboxName}`);
        console.log(`      Error: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`);
        if (result.responseHeaders) {
          console.log(`      Response Headers:`, JSON.stringify(result.responseHeaders, null, 2));
        }
        if (result.responseBody) {
          console.log(`      Response Body:`, result.responseBody);
        }
      }
    });
  }

  // Clean up HTTP/2 sessions
  http2Sessions.forEach((session) => {
    session.close();
  });

  // Summary statistics
  console.log("\n=== SUMMARY ===");
  const successfulResults = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);

  console.log(`Total checks: ${results.length}`);
  console.log(`Successful: ${successfulResults.length}`);
  console.log(`Failed: ${failedResults.length}`);

  if (successfulResults.length > 0) {
    const avgSandboxCreation = successfulResults.reduce((sum, r) => sum + r.sandboxCreationTime, 0) / successfulResults.length;
    const avgHealthCheck = successfulResults.reduce((sum, r) => sum + r.healthCheckTime, 0) / successfulResults.length;
    const avgAvailabilityGap = successfulResults.reduce((sum, r) => sum + r.availabilityGap, 0) / successfulResults.length;
    const avgTotal = successfulResults.reduce((sum, r) => sum + r.totalTime, 0) / successfulResults.length;

    const minAvailabilityGap = Math.min(...successfulResults.map(r => r.availabilityGap));
    const maxAvailabilityGap = Math.max(...successfulResults.map(r => r.availabilityGap));

    console.log("\nAverage timings:");
    console.log(`  Sandbox creation: ${avgSandboxCreation.toFixed(0)}ms`);
    console.log(`  Health check: ${avgHealthCheck.toFixed(0)}ms`);
    console.log(`  Availability gap: ${avgAvailabilityGap.toFixed(0)}ms`);
    console.log(`  Total: ${avgTotal.toFixed(0)}ms`);

    console.log("\nAvailability gap range:");
    console.log(`  Min: ${minAvailabilityGap}ms`);
    console.log(`  Max: ${maxAvailabilityGap}ms`);
  }

  if (failedResults.length > 0) {
    console.log("\nFailed checks:");
    failedResults.forEach((result, idx) => {
      console.log(`  ${idx + 1}. ${result.sandboxName}: ${result.error}`);
    });

    // Group errors by HTTP status
    console.log("\nErrors by HTTP status:");
    const errorsByStatus = new Map<number | string, number>();
    failedResults.forEach((result) => {
      const key = result.httpStatus ? result.httpStatus : "network/other";
      errorsByStatus.set(key, (errorsByStatus.get(key) || 0) + 1);
    });

    Array.from(errorsByStatus.entries())
      .sort((a, b) => {
        // Sort numbers first, then "network/other"
        if (typeof a[0] === "number" && typeof b[0] === "number") {
          return a[0] - b[0];
        }
        if (typeof a[0] === "number") return -1;
        if (typeof b[0] === "number") return 1;
        return 0;
      })
      .forEach(([status, count]) => {
        console.log(`  ${status}: ${count} occurrence(s)`);
      });
  }
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    // Clean up HTTP/2 sessions on error
    http2Sessions.forEach((session) => {
      session.close();
    });
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });

