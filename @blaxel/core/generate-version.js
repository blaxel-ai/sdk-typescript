#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get version from latest git tag
let version = 'unknown';
try {
  // Try to get the latest git tag
  version = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
  // Remove 'v' prefix if present (e.g., v1.0.0 -> 1.0.0)
  version = version.replace(/^v/, '');
  console.log('✅ Git tag version:', version);
} catch (e) {
  // Fallback to package.json if no git tags exist
  console.log('⚠️  Could not get git tag, falling back to package.json:', e.message);
  try {
    const packageJson = require('./package.json');
    version = packageJson.version;
    console.log('✅ Package.json version:', version);
  } catch (err) {
    console.log('⚠️  Could not read package.json:', err.message);
  }
}

// Get git commit hash
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  console.log('✅ Git commit:', commit.substring(0, 7));
} catch (e) {
  console.log('⚠️  Could not get git commit:', e.message);
}

// Generate version.ts content
const versionFileContent = `// This file is auto-generated during build. Do not edit manually.
export const PACKAGE_VERSION = "${version}";
export const PACKAGE_COMMIT = "${commit}";
`;

// Write to src/common/version.ts
const versionFilePath = path.join(__dirname, 'src', 'common', 'version.ts');
fs.writeFileSync(versionFilePath, versionFileContent);

console.log('✅ Generated version.ts with version:', version);

