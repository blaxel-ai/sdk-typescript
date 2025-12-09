/* eslint-disable */

// Browser-compatible exports for Node.js modules
// In browser environments, Node.js built-in modules are not available

// All Node.js modules are null in browser
export const crypto: any = null;
export const fs: any = null;
export const os: any = null;
export const path: any = null;
export const dotenv: any = null;

// Async function to get WebSocket in browser environment
export async function getWebSocket(): Promise<any> {
  // In browser, use native WebSocket
  if (typeof WebSocket !== 'undefined') {
    return WebSocket;
  } else {
    throw new Error("Native WebSocket not available in browser environment");
  }
}
