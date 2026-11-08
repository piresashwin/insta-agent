/**
 * Simple key/value app settings in SQLite (survives restarts; no .env reload needed).
 */
import db from './db'

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined
  const v = row?.value
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function setSetting(key: string, value: string | null): void {
  if (value == null || !String(value).trim()) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
    return
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, String(value).trim())
}

export const SETTING_PUBLISH_TUNNEL_BASE = 'publish_tunnel_base'
export const SETTING_PUBLISH_TUNNEL_PID = 'publish_tunnel_pid'
