# Dynamic Sandbox Demo

This is a demo application showing how to use Blaxel sandbox without local persistence/auth.

## Features

- No login/authentication required
- No local database; uses Blaxel control plane
- Sandbox instances managed via Blaxel SDK
- Process management in sandbox

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Run the development server:
   ```
   npm run dev
   ```
4. Open [http://localhost:3000](http://localhost:3000) in your browser

## How It Works

1. The app lists sandboxes via SandboxInstance.list()
2. You can create/delete sandboxes via the API routes
3. Processes can be started/stopped in the sandbox
4. The live preview is displayed in the app

## Tech Stack

- Next.js 15
- Blaxel SDK
