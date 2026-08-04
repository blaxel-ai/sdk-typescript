// test-gateway-error.mjs — requires @blaxel/core >= 0.3.9
import {
    SandboxGatewayError, ResponseError,
    isGatewayError, isGatewayTimeout, SandboxInstance,
  } from "@blaxel/core";

  // Part A (offline): simulate a 504 and confirm the typed error + helpers
  const err = new SandboxGatewayError(
    new Response(null, { status: 504, statusText: "Gateway Timeout" }), null, null,
  );
  console.log("message:", err.message);
  console.log("status :", err.status);                          // 504
  console.log("instanceof SandboxGatewayError:", err instanceof SandboxGatewayError); // true
  console.log("instanceof ResponseError      :", err instanceof ResponseError);       // true
  console.log("isGatewayTimeout:", isGatewayTimeout(err));      // true
  console.log("isGatewayError  :", isGatewayError(err));        // true

  // Part B (optional, real): the pattern your app should use.
  // Run:  node test-gateway-error.mjs <sandboxName>   (needs BL_API_KEY + BL_WORKSPACE)
  const name = process.argv[2];
  const sandbox = await SandboxInstance.get(name);
  try {
    const result = await sandbox.process.exec({ command: "echo hello", waitForCompletion: true });
    console.log("exec ok, logs:", JSON.stringify(result.logs));
  } catch (e) {
    if (e instanceof SandboxGatewayError) {
      console.log("Caught gateway error cleanly:", e.status, "-", e.message);
    } else throw e;
  }
