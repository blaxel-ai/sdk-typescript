# Code Execution Agent with Mastra

This agent demonstrates the code execution pattern described in the Anthropic article: [Code execution with MCP: Building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp).

## Overview

Instead of loading all tool definitions upfront and making individual tool calls, this agent:
1. Generates TypeScript/JavaScript code to accomplish tasks
2. Executes that code in a Blaxel sandbox environment
3. Uses tools on-demand following progressive disclosure

This approach is more efficient because:
- Only loads tool definitions when needed
- Processes data in the execution environment before returning results
- Handles complex logic, loops, and conditionals in a single execution step
- Reduces token consumption significantly

## Features

- **Code Generation**: Generates TypeScript/JavaScript code dynamically
- **Sandbox Execution**: Runs code in isolated Blaxel sandbox environments
- **File Operations**: Read/write files in the sandbox
- **Command Execution**: Run shell commands when needed
- **Streaming Support**: Stream responses for better UX
- **Error Handling**: Graceful error handling and recovery

## Tools Structure

The agent populates the sandbox with a `/tools` directory structure following the article's pattern:

The agent uses these high-level tools:
1. `generateAndExecuteCode` - Primary tool for code execution
2. `readSandboxFile` - Read files from sandbox
3. `writeSandboxFile` - Write files to sandbox
4. `listSandboxDirectory` - List directory contents
5. `executeSandboxCommand` - Execute shell commands

The agent discovers available tools by exploring the `/tools` directory and generates code that imports and uses them, following the progressive disclosure pattern from the article.

## Running the Tests

```bash
# Install dependencies (from sdk-typescript root)
pnpm install

# Run tests
cd tests/code-execution-agent
pnpm test

# Or run with watch mode
pnpm test:watch
```

## Example Usage

### Basic Example

```typescript
import { CodeExecutionAgent } from "./agent.js";

const agent = new CodeExecutionAgent("my-sandbox");

// Generate and execute code
const result = await agent.run(
  "Calculate the factorial of 10 and print the result"
);

console.log(result);
```

### Google Drive + Salesforce Example (from Article)

```typescript
import { CodeExecutionAgent } from "./agent.js";

const agent = new CodeExecutionAgent("my-sandbox");

// This follows the exact pattern from the Anthropic article
const result = await agent.run(
  `Download my meeting transcript from Google Drive (document ID: 'abc123')
   and attach it to the Salesforce lead (record ID: '00Q5f000001abcXYZ',
   object type: 'SalesMeeting').`
);

console.log(result);
```

The agent will generate code like:
```typescript
import * as gdrive from '/tools/google-drive/index.js';
import * as salesforce from '/tools/salesforce/index.js';

const transcript = (await gdrive.getDocument({ documentId: 'abc123' })).content;
await salesforce.updateRecord({
  objectType: 'SalesMeeting',
  recordId: '00Q5f000001abcXYZ',
  data: { Notes: transcript }
});
```

## Architecture

The agent follows the code execution pattern:

1. **High-level tools**: Provides tools for code generation and execution
2. **Progressive disclosure**: Loads sandbox tools on-demand, not all upfront
3. **Code-first approach**: Generates code to accomplish tasks rather than chaining tool calls
4. **Efficient execution**: Processes data in sandbox before returning to model

This reduces token usage from ~150,000 tokens to ~2,000 tokens for complex operations (98.7% reduction as shown in the article).

