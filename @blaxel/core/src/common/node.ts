/* eslint-disable */

// Import Node.js built-in modules using ES6 imports for ESM compatibility
import * as fsImport from "fs";
import * as osImport from "os";
import * as pathImport from "path";

// Detect environments
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

const isBrowser = typeof globalThis !== "undefined" && (globalThis as any)?.window !== undefined;

// Initialize modules
let fs: typeof import("fs") | null = null;
let os: typeof import("os") | null = null;
let path: typeof import("path") | null = null;
let dotenv: typeof import("dotenv") | null = null;
let ws: any = null; // Used internally by getWebSocket() for caching

if (isNode && !isBrowser) {
  // Use the imported modules directly - these are Node.js built-ins, always available
  fs = fsImport;
  os = osImport;
  path = pathImport;

  // Try to load optional dependencies
  try {
    dotenv = eval("require")("dotenv");
  } catch {
    // dotenv not available
    dotenv = null;
  }

  try {
    ws = eval("require")("ws");
  } catch {
    // Will be loaded dynamically via getWebSocket() when needed
    ws = null;
  }
}

// Async function to get WebSocket in any environment
export async function getWebSocket(): Promise<any> {
  // Check if we're in a browser environment
  const isBrowserEnv = typeof globalThis !== "undefined" && (globalThis as any)?.window !== undefined;

  if (isBrowserEnv) {
    // In browser, use native WebSocket
    if (typeof WebSocket !== 'undefined') {
      return WebSocket;
    } else {
      throw new Error("Native WebSocket not available in browser environment");
    }
  }

  // Node.js environment - if we already have WebSocket loaded synchronously, return it
  if (ws) {
    return ws;
  }

  // For Node.js ESM environments, try dynamic import
  try {
    const wsModule = await import("ws");
    const loadedWs = wsModule.default || wsModule;
    // Cache it for future use
    ws = loadedWs;
    return loadedWs;
  } catch (error) {
    throw new Error(`WebSocket library 'ws' not available: ${(error as Error)?.message || error}`);
  }
}

export { dotenv, fs, os, path };

