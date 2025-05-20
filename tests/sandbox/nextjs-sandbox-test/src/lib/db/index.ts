import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { join } from 'path';
import * as schema from './schema';

// Initialize the database
const sqlite = new Database(join(process.cwd(), 'sqlite.db'));
export const db = drizzle(sqlite, { schema });

// Create the tables if they don't exist
const initDb = () => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      sandbox_name TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sandboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      description TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      last_accessed_at INTEGER DEFAULT (unixepoch())
    );
  `);
};

// Initialize the database
initDb();