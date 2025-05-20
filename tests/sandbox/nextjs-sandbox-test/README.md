# Dynamic Sandbox Demo

This is a demo application showing how to use Beamlit sandbox with user management.

## Features

- User login with email (no password needed for simplicity)
- SQLite database for user storage
- User-specific sandbox instances
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

1. Users enter their email in the login page
2. The system creates or retrieves a user profile from SQLite
3. A unique sandbox instance is created for each user
4. Processes can be started/stopped in the sandbox
5. The live preview is displayed in the app

## Tech Stack

- Next.js 15
- SQLite (via better-sqlite3)
- Drizzle ORM
- Beamlit SDK
