/* eslint-disable */
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

let fs: any = null;
let os: any = null;
if (isNode) {
  fs = require("fs");
  os = require("os");
}

export { fs, os };
