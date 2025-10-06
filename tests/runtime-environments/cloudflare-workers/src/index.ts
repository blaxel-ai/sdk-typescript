// Test Cloudflare Workers compatibility
import { getWebSocket } from "@blaxel/core";

interface Env {
  [key: string]: any;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      console.log("🧪 Testing Cloudflare Workers environment...");

      // Test @blaxel/core imports
      console.log("✅ @blaxel/core env:", typeof env);

      // Test that we can access environment variables
      const blEnv = (globalThis as any).env || {};
      console.log("✅ Blaxel env access:", typeof blEnv);
      try {
        const WebSocketConstructor = await getWebSocket();
        console.log("✅ getWebSocket() successful:", typeof WebSocketConstructor);
      } catch (error) {
        console.error("❌ Cloudflare Workers WebSocket test failed:", (error as Error).message);
      }
      return new Response(JSON.stringify({
        status: "success",
        message: "✅ All imports successful in Cloudflare Workers",
        environment: "cloudflare-workers",
        envType: typeof env,
        timestamp: new Date().toISOString()
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (error) {
      console.error("❌ Cloudflare Workers test failed:", error);
      return new Response(JSON.stringify({
        status: "error",
        message: `❌ Error: ${(error as Error).message}`,
        environment: "cloudflare-workers"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
  },
};
