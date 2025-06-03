/* eslint-disable */
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

let fs: typeof import("fs") | null = null;
let os: typeof import("os") | null = null;
let path: typeof import("path") | null = null;
let dotenv: typeof import("dotenv") | null = null;
let ws: typeof import("ws") | null = null;
declare const globalThis: {
  window: any;
};
const isBrowser = typeof globalThis !== "undefined" && globalThis && globalThis.window !== undefined;
if (isNode) {
  try {
    fs = eval("require")("fs");
    os = eval("require")("os");
    path = eval("require")("path");
    dotenv = eval("require")("dotenv");
    ws = eval("require")("ws");
  } catch (e) {
    console.warn("fs, os, path, dotenv, ws are not available in this environment");
  }
}
// cloudflare
else if (!isBrowser) {
  try {
    ws = eval("require")("ws");
  } catch (e) {
    console.warn("ws is not available in this environment");
  }
}



export { dotenv, fs, os, path, ws };

