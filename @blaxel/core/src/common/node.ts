/* eslint-disable */
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

let fs: typeof import("fs") | null = null;
let os: typeof import("os") | null = null;
let path: typeof import("path") | null = null;
let dotenv: typeof import("dotenv") | null = null;
let FormData: typeof import("form-data") | null = null;
if (isNode) {
  try {
    fs = eval("require")("fs");
    os = eval("require")("os");
    path = eval("require")("path");
    dotenv = eval("require")("dotenv");
    FormData = eval("require")("form-data");
  } catch (e) {
    console.warn("fs and os are not available in this environment");
  }
}

export { dotenv, FormData, fs, os, path };

