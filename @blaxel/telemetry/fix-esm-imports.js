const fs = require('fs');
const path = require('path');

function fixEsmFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Fix @modelcontextprotocol/sdk imports to add .js extensions
    content = content.replace(/from\s+['"](@modelcontextprotocol\/sdk\/[^'"]+)(?<!\.js)['"]/g, 'from "$1.js"');

    // Fix npm package imports that got .js added incorrectly (but not @modelcontextprotocol)
    content = content.replace(/from\s+['"](@(?!modelcontextprotocol)[^'"]*?)\.js['"]/g, 'from "$1"');
    content = content.replace(/import\s+['"](@(?!modelcontextprotocol)[^'"]*?)\.js['"]/g, 'import "$1"');
    content = content.replace(/from\s+['"]([a-zA-Z][^'"]*?)\.js['"]/g, 'from "$1"');
    content = content.replace(/import\s+['"]([a-zA-Z][^'"]*?)\.js['"]/g, 'import "$1"');

    // Remove any double .js.js extensions
    content = content.replace(/\.js\.js/g, '.js');

    // Add .js extensions ONLY to relative imports (starting with . or ..) that don't have extensions
    content = content.replace(/from\s+['"](\.[^'"]*?)['"](?!\.[a-zA-Z])/g, (match, importPath) => {
        if (importPath.endsWith('.js')) return match;
        return `from "${importPath}.js"`;
    });
    content = content.replace(/import\s+['"](\.[^'"]*?)['"](?!\.[a-zA-Z])/g, (match, importPath) => {
        if (importPath.endsWith('.js')) return match;
        return `import "${importPath}.js"`;
    });

    fs.writeFileSync(filePath, content);
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walkDir(filePath);
        } else if (file.endsWith('.js')) {
            fixEsmFile(filePath);
        }
    });
}

try {
    walkDir('dist/esm');
    console.log('✅ Fixed ESM imports for Node.js compatibility');
} catch (e) {
    console.log('⚠️  Could not fix ESM imports:', e.message);
}
