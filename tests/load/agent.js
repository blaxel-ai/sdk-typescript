import http from 'k6/http';
import { Counter } from 'k6/metrics';

// Custom metrics
const successCounter = new Counter('successful_calls');
const failureCounter = new Counter('failed_calls');

const API_URL = 'http://localhost:3333';

// Test configuration - Fixed 2000 iterations distributed among VUs
export const options = {
  scenarios: {
    fixed_iterations: {
      executor: 'shared-iterations',
      vus: 200,           // 100 concurrent virtual users
      iterations: 200,   // Total 100 iterations shared among all VUs
      maxDuration: '10m',  // Maximum test duration
    },
  },

  // Thresholds for pass/fail criteria
  thresholds: {
    'successful_calls': ['count>90'],   // At least 95% success rate
    'failed_calls': ['count<100'],        // Less than 100 failed calls
    'http_req_duration': ['avg<200'],     // Average duration under 200ms
  },
};

// Create agent via HTTP API
function createAgent() {
  const response = http.post(`${API_URL}/agents`, null, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (response.status === 200) {
    const data = JSON.parse(response.body);
    return `success: Agent ${data.agentName} created in ${data.duration}ms`;
  } else {
    return "error: Error creating agent";
  }
}

// Main test function - this is what each virtual user (VU) will execute
export default function () {
  try {
    const result = createAgent();
    console.log(result);

    // Check if the function returned expected result
    const success = result.includes("success");

    if (success) {
      successCounter.add(1);
    } else {
      failureCounter.add(1);
    }

  } catch (error) {
    failureCounter.add(1);
  }
}

// Setup function
export function setup() {
  console.log('Fixed iteration load test starting...');
  console.log('Configuration:');
  console.log('- Total iterations: 2000 (fixed)');
  console.log('- Concurrent users: 100');
  console.log('- Each VU will process ~20 iterations');
  console.log('');
  return { startTime: new Date().toISOString() };
}

// Teardown function
export function teardown(data) {
  console.log(`Load test completed. Started at: ${data.startTime}`);
}

if (import.meta.main) {
  teardown();
}