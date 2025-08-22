import { SandboxInstance, SessionWithToken } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

const sandboxName = "preview-token"

// Helper function to sleep for a specified duration
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const sandbox = await createOrGetSandbox({
        sandboxName,
    });

    console.log("\n=== Creating first session token (expires in 1 minute) ===");
    await getSessionToken(sandbox)

    console.log("\n=== Sleeping for 2 minutes... ===");
    await sleep(2 * 60 * 1000); // Sleep for 2 minutes

    console.log("\n=== Getting session token again (should create new one as first expired) ===");
    await getSessionToken(sandbox)

    await SandboxInstance.delete(sandboxName)

}

async function getSessionToken(sandbox: SandboxInstance) {
    const sessionExpirationTime = 1000 * 60 * 1 // 1 minute
    const sessionExpirationBuffer = 1000 * 30 // 30 seconds buffer
    const expiresAt = new Date(Date.now() + sessionExpirationTime)
    const session = await sandbox.sessions.createIfExpired({
        expiresAt,
        responseHeaders: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    }, sessionExpirationBuffer);
    console.log("Session created/retrieved:");
    console.log("- Token:", session.token);
    console.log("- Expires at:", session.expiresAt);
    console.log("- Time until expiry:", Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 1000), "seconds");
}

main();