/* eslint-disable */
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

let fs: typeof import("fs") | null = null;
let os: typeof import("os") | null = null;
if (isNode) {
  fs = eval("require")("fs");
  os = eval("require")("os");
}

export { fs, os };
