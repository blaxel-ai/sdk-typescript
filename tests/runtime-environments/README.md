# Runtime Environment Compatibility Tests

This directory contains comprehensive tests to ensure the @blaxel SDK packages work correctly across different JavaScript/TypeScript runtime environments and module resolution strategies.

## Test Environments

### 🌐 Node.js Environments

#### 1. `nodejs-nodenext/` - Modern Node.js (NodeNext)
- **Runtime**: Node.js with modern ESM support
- **moduleResolution**: `"NodeNext"`
- **module**: `"NodeNext"`
- **type**: `"module"` (ESM)

#### 2. `nodejs-node16/` - Node.js 16+ (Node16)
- **Runtime**: Node.js 16+ with ESM support
- **moduleResolution**: `"Node16"`
- **module**: `"Node16"`
- **type**: `"module"` (ESM)

#### 3. `nodejs-legacy/` - Legacy Node.js (Node)
- **Runtime**: Legacy Node.js behavior
- **moduleResolution**: `"node"` (legacy)
- **module**: `"CommonJS"`
- **type**: Not specified (CJS default)
- **Note**: This was the customer's problematic configuration

#### 4. `nodejs-javascript-cjs/` - Plain JavaScript CommonJS
- **Runtime**: Node.js with plain JavaScript
- **Module system**: CommonJS with `require()`
- **No TypeScript**: Tests pure JavaScript compatibility

#### 5. `nodejs-javascript-esm/` - Plain JavaScript ESM
- **Runtime**: Node.js with plain JavaScript
- **Module system**: ESM with `import`
- **No TypeScript**: Tests pure JavaScript ESM compatibility

### 🚀 Alternative Runtimes

#### 6. `bun/` - Bun Runtime
- **Runtime**: Bun (alternative JavaScript runtime)
- **moduleResolution**: `"bundler"`
- **module**: `"ESNext"`
- **Features**: Tests Bun-specific APIs and performance

#### 7. `cloudflare-workers/` - Cloudflare Workers
- **Runtime**: Cloudflare Workers (V8 isolates)
- **moduleResolution**: `"bundler"`
- **module**: `"ES2022"`
- **Features**: Tests edge computing environment

#### 8. `browser/` - Browser Environment
- **Runtime**: Browser with Vite bundler
- **moduleResolution**: `"bundler"`
- **module**: `"ES2022"`
- **Features**: Tests browser compatibility and bundling

## Running Tests

### Run All Tests
```bash
# From the SDK root directory
pnpm test:runtime-environments

# Or directly
./tests/runtime-environments/test-all.sh
```

### Run Individual Environment Tests
```bash
# Node.js environments
cd tests/runtime-environments/nodejs-legacy && pnpm lint && pnpm build && pnpm test
cd tests/runtime-environments/nodejs-nodenext && pnpm lint && pnpm build && pnpm test

# JavaScript environments
cd tests/runtime-environments/nodejs-javascript-cjs && pnpm lint && pnpm test
cd tests/runtime-environments/nodejs-javascript-esm && pnpm lint && pnpm test

# Alternative runtimes
cd tests/runtime-environments/bun && pnpm lint && pnpm build && pnpm test
cd tests/runtime-environments/cloudflare-workers && pnpm lint && pnpm build && pnpm test
cd tests/runtime-environments/browser && pnpm lint && pnpm build && pnpm test
```

## What Each Test Validates

### Automated Tests
1. **ESLint**: Can ESLint parse and validate imports from @blaxel packages?
2. **TypeScript Compilation**: Can TypeScript resolve and compile imports? (where applicable)
3. **Runtime Execution**: Can the runtime load and execute the code?
4. **Type Safety**: Are TypeScript types correctly resolved? (where applicable)

### Manual Tests
- **Cloudflare Workers**: Requires `wrangler dev` and browser testing
- **Browser**: Requires `vite dev` and browser testing

## Test Coverage

Each test imports and validates:
- `env` from `@blaxel/core`
- `getTool` and `ToolOptions` from `@blaxel/core` (where supported)
- `@blaxel/telemetry` (side-effect import)
- Runtime-specific APIs and features

## Expected Results

✅ **All tests should pass**, demonstrating that the SDK works correctly with:
- **All Node.js module resolution strategies** (NodeNext, Node16, legacy node)
- **Both TypeScript and plain JavaScript**
- **Both CommonJS and ESM module systems**
- **Alternative runtimes** (Bun, Cloudflare Workers, Browser)

## The Dual-Build Solution

The SDK uses a **standard dual-build approach** to achieve this compatibility:

```
dist/
├── cjs/           # CommonJS build + types (for legacy consumers)
│   ├── index.js
│   └── types/
│       └── index.d.ts
└── esm/           # ESM build + types (for modern consumers)
    ├── index.js
    └── types/
        └── index.d.ts
```

This ensures customers can use the SDK with **any** configuration without changes to their existing setup!
