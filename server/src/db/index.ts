import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'

const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', '..', 'content-agent.db')

// Ensure the file exists before opening (DatabaseSync requires it)
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, '')
}

export const db = new DatabaseSync(dbPath, { readOnly: false })

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`)

// Migration runner
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`)

const migrationsDir = path.join(__dirname, 'migrations')
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

for (const file of migrationFiles) {
  const version = parseInt(file.split('_')[0], 10)
  const already = db
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
    .get(version)
  if (already) continue

  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')

  // Run the full migration in one shot. All DDL uses IF NOT EXISTS so it's
  // idempotent. We try once; if it fails due to "already exists" we swallow
  // that and mark the migration done anyway (additive-only scenario).
  try {
    db.exec(sql)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      throw err
    }
  }

  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
    version,
    file,
  )
}

export default db
