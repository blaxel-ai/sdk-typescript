#!/usr/bin/env node

/**
 * This script replaces `workspace:*` dependencies with actual versions
 * before publishing to npm. npm doesn't handle workspace protocol,
 * so we need to resolve these manually.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Get all workspace package.json files
const workspaces = ['core', 'telemetry', 'langgraph', 'llamaindex', 'vercel', 'mastra'];

// Build a map of package name -> version
const packageVersions = new Map();

for (const workspace of workspaces) {
  const pkgPath = join(rootDir, '@blaxel', workspace, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    packageVersions.set(pkg.name, pkg.version);
    console.log(`Found ${pkg.name}@${pkg.version}`);
  } catch (err) {
    console.error(`Failed to read ${pkgPath}:`, err.message);
    process.exit(1);
  }
}

// Now replace workspace:* in all package.json files
let modified = 0;

for (const workspace of workspaces) {
  const pkgPath = join(rootDir, '@blaxel', workspace, 'package.json');
  const pkgContent = readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(pkgContent);
  let changed = false;

  // Check all dependency types
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!pkg[depType]) continue;

    for (const [dep, version] of Object.entries(pkg[depType])) {
      if (version === 'workspace:*') {
        const actualVersion = packageVersions.get(dep);
        if (actualVersion) {
          pkg[depType][dep] = actualVersion;
          const suffix = depType === 'dependencies' ? '' : ` (${depType.replace('Dependencies', '')})`;
          console.log(`  ${pkg.name}: ${dep} -> ${actualVersion}${suffix}`);
          changed = true;
        } else {
          console.error(`  ${pkg.name}: Could not find version for ${dep}`);
          process.exit(1);
        }
      }
    }
  }

  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
    modified++;
  }
}

console.log(`\nReplaced workspace:* in ${modified} package(s)`);
