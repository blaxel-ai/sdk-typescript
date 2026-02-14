const fs = require('fs');
const path = require('path');

/**
 * This script creates browser-compatible builds by:
 * 1. Replacing node.js files with browser.js content
 * 2. Updating all imports to use browser.js
 */

function fixBrowserImports(dir) {
  const files = fs.readdirSync(dir);

  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      fixBrowserImports(filePath);
    } else if (filePath.endsWith('.js')) {
      let content = fs.readFileSync(filePath, 'utf8');

      // Replace imports from ./node.js or ../common/node.js with browser.js
      content = content.replace(/from\s+["']([.\/]*common\/)?node\.js["']/g, (match, prefix) => {
        const prefixPath = prefix || '';
        return `from "${prefixPath}browser.js"`;
      });

      // Replace require calls (for CJS build)
      content = content.replace(/require\(["']([.\/]*common\/)?node\.js["']\)/g, (match, prefix) => {
        const prefixPath = prefix || '';
        return `require("${prefixPath}browser.js")`;
      });

      fs.writeFileSync(filePath, content);
    }
  });
}

function replaceNodeWithBrowser(buildDir) {
  // File paths for both node and browser files
  const nodePath = path.join(buildDir, 'common', 'node.js');
  const nodeTypesPath = path.join(buildDir, 'common', 'node.d.ts');
  const browserPath = path.join(buildDir, 'common', 'browser.js');
  const browserTypesPath = path.join(buildDir, 'common', 'browser.d.ts');

  // Replace node.js with browser.js content
  if (fs.existsSync(browserPath) && fs.existsSync(nodePath)) {
    // Delete the original node.js
    fs.unlinkSync(nodePath);
    // Rename browser.js to node.js (keep the same filename for imports)
    fs.renameSync(browserPath, nodePath);
    console.log(`  ✅ Replaced node.js with browser.js content`);
  } else if (!fs.existsSync(browserPath)) {
    console.error(`  ⚠️  Warning: browser.js not found in ${buildDir}/common/`);
    console.error(`     Make sure browser.ts is compiled in the regular build first.`);
  }

  // Replace node.d.ts with browser.d.ts if they exist
  if (fs.existsSync(browserTypesPath) && fs.existsSync(nodeTypesPath)) {
    fs.unlinkSync(nodeTypesPath);
    fs.renameSync(browserTypesPath, nodeTypesPath);
    console.log(`  ✅ Replaced node.d.ts with browser.d.ts content`);
  }
}

function replaceImageWithBrowser(buildDir) {
  // File paths for both image and image.browser files
  const imagePath = path.join(buildDir, 'image', 'image.js');
  const imageTypesPath = path.join(buildDir, 'image', 'image.d.ts');
  const browserPath = path.join(buildDir, 'image', 'image.browser.js');
  const browserTypesPath = path.join(buildDir, 'image', 'image.browser.d.ts');

  // Replace image.js with image.browser.js content
  if (fs.existsSync(browserPath) && fs.existsSync(imagePath)) {
    // Delete the original image.js
    fs.unlinkSync(imagePath);
    // Rename image.browser.js to image.js (keep the same filename for imports)
    fs.renameSync(browserPath, imagePath);
    console.log(`  ✅ Replaced image.js with image.browser.js content`);
  } else if (!fs.existsSync(browserPath)) {
    console.error(`  ⚠️  Warning: image.browser.js not found in ${buildDir}/image/`);
    console.error(`     Make sure image.browser.ts is compiled in the regular build first.`);
  }

  // Replace image.d.ts with image.browser.d.ts if they exist
  if (fs.existsSync(browserTypesPath) && fs.existsSync(imageTypesPath)) {
    fs.unlinkSync(imageTypesPath);
    fs.renameSync(browserTypesPath, imageTypesPath);
    console.log(`  ✅ Replaced image.d.ts with image.browser.d.ts content`);
  }
}

// Create browser-specific builds
const builds = ['dist/esm-browser', 'dist/cjs-browser'];

builds.forEach(buildDir => {
  const sourceDir = buildDir.replace('-browser', '');

  if (fs.existsSync(sourceDir)) {
    // Copy the build directory
    const copyRecursive = (src, dest) => {
      if (fs.statSync(src).isDirectory()) {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach(file => {
          copyRecursive(path.join(src, file), path.join(dest, file));
        });
      } else {
        fs.copyFileSync(src, dest);
      }
    };

    console.log(`Creating browser build: ${buildDir}`);
    copyRecursive(sourceDir, buildDir);

    // Replace node.js with browser.js content
    replaceNodeWithBrowser(buildDir);

    // Replace image.js with image.browser.js content (removes archiver dependency)
    replaceImageWithBrowser(buildDir);

    // Note: We don't need to fix imports since node.js now contains browser.js content
    // sentry.ts now handles both Node.js and browser environments with fetch
    // All imports to node.js will get the browser-safe version

    // Copy package.json for ESM
    if (buildDir.includes('esm-browser')) {
      fs.writeFileSync(path.join(buildDir, 'package.json'), '{"type":"module"}');
    }

    console.log(`✅ Browser build created: ${buildDir}`);
  }
});
