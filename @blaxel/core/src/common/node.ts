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
let ws: any = null;

if (isNode && !isBrowser) {
  // Use the imported modules directly
  fs = fsImport;
  os = osImport;
  path = pathImport;

  // Try to load dotenv and ws using require since they're not built-ins
  try {
    dotenv = eval("require")("dotenv");
    ws = eval("require")("ws");
  } catch (requireError) {
    // Try alternative loading for ESM
    try {
      dotenv = eval("require")("dotenv");
    } catch {
      // console.warn("dotenv not available");
    }
    try {
      ws = eval("require")("ws");
    } catch {
      // console.warn("ws not available");
    }
  }
}

export { dotenv, fs, os, path, ws };
