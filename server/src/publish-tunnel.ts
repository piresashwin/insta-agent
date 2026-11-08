/**
 * Ephemeral cloudflared quick tunnel for Instagram publish only.
 * URL is stored in app_settings so publish can read it live (no API restart).
 */
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  getSetting,
  setSetting,
  SETTING_PUBLISH_TUNNEL_BASE,
  SETTING_PUBLISH_TUNNEL_PID,
} from './settings'
import { localApiBase } from './media/r2'

export type PublishTunnelStatus = {
  base_url: string | null
  pid: number | null
  process_alive: boolean
  reachable: boolean | null
  source: 'database' | 'env' | 'none'
  log_path: string
}

const LOG_PATH = path.join(os.tmpdir(), 'instagram-agent-publish-tunnel.log')

let child: ChildProcess | null = null

function port(): number {
  return Number(process.env.PORT || 3001)
}

function envPublishBase(): string | null {
  const base = (process.env.PUBLIC_API_BASE || '').trim().replace(/\/$/, '')
  if (!base.startsWith('https://')) return null
  return base
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function storedPid(): number | null {
  const raw = getSetting(SETTING_PUBLISH_TUNNEL_PID)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function killPid(pid: number) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  try {
    // Also clear any orphaned quick tunnels we started
    spawn('pkill', ['-f', 'cloudflared tunnel --url'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

function extractTunnelUrl(logText: string): string | null {
  const matches = logText.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)
  if (!matches?.length) return null
  return matches[matches.length - 1].replace(/\/$/, '')
}

async function probeReachable(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/brand-profiles`, {
      method: 'GET',
      redirect: 'follow',
    })
    return res.ok
  } catch {
    return false
  }
}

/** Prefer DB tunnel (live, no restart); fall back to PUBLIC_API_BASE env. */
export function resolvePublishTunnelBase(): {
  base: string | null
  source: 'database' | 'env' | 'none'
} {
  const fromDb = getSetting(SETTING_PUBLISH_TUNNEL_BASE)
  if (fromDb?.startsWith('https://')) {
    return { base: fromDb.replace(/\/$/, ''), source: 'database' }
  }
  const fromEnv = envPublishBase()
  if (fromEnv) return { base: fromEnv, source: 'env' }
  return { base: null, source: 'none' }
}

export async function getPublishTunnelStatus(): Promise<PublishTunnelStatus> {
  const { base, source } = resolvePublishTunnelBase()
  const pid = storedPid()
  const alive = pidAlive(pid) || (child?.pid ? pidAlive(child.pid) : false)
  let reachable: boolean | null = null
  if (base) reachable = await probeReachable(base)
  return {
    base_url: base,
    pid: child?.pid || pid,
    process_alive: alive,
    reachable,
    source,
    log_path: LOG_PATH,
  }
}

export async function stopPublishTunnel(): Promise<PublishTunnelStatus> {
  const pid = storedPid()
  if (child?.pid) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    child = null
  }
  if (pid) killPid(pid)
  setSetting(SETTING_PUBLISH_TUNNEL_PID, null)
  setSetting(SETTING_PUBLISH_TUNNEL_BASE, null)
  return getPublishTunnelStatus()
}

/**
 * Start (or restart) a quick tunnel and persist the HTTPS URL in SQLite.
 */
export async function startPublishTunnel(): Promise<PublishTunnelStatus> {
  // Origin must be up
  const local = localApiBase()
  try {
    const health = await fetch(`${local}/api/brand-profiles`)
    if (!health.ok) {
      throw new Error(`Local API not healthy at ${local} (HTTP ${health.status})`)
    }
  } catch (e) {
    throw new Error(
      `Local API not reachable at ${local}. Start the server first. (${(e as Error).message})`
    )
  }

  // Stop previous
  await stopPublishTunnel()
  await sleep(800)

  try {
    fs.writeFileSync(LOG_PATH, '')
  } catch {
    /* ignore */
  }

  const origin = `http://localhost:${port()}`
  const proc = spawn(
    'cloudflared',
    ['tunnel', '--url', origin, '--edge-ip-version', '4', '--protocol', 'http2'],
    {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }
  )
  child = proc
  if (proc.pid) setSetting(SETTING_PUBLISH_TUNNEL_PID, String(proc.pid))

  const append = (buf: Buffer) => {
    try {
      fs.appendFileSync(LOG_PATH, buf)
    } catch {
      /* ignore */
    }
  }
  proc.stdout.on('data', append)
  proc.stderr.on('data', append)
  proc.on('exit', () => {
    if (child === proc) child = null
  })

  let url: string | null = null
  const deadline = Date.now() + 55_000
  while (Date.now() < deadline) {
    let logText = ''
    try {
      logText = fs.readFileSync(LOG_PATH, 'utf8')
    } catch {
      logText = ''
    }
    url = extractTunnelUrl(logText)
    if (url && /Registered tunnel connection/i.test(logText)) {
      await sleep(2500)
      if (await probeReachable(url)) break
    }
    if (proc.exitCode != null) {
      throw new Error(
        `cloudflared exited early (code ${proc.exitCode}). Is it installed? See ${LOG_PATH}`
      )
    }
    await sleep(1000)
  }

  if (!url) {
    try {
      proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    child = null
    setSetting(SETTING_PUBLISH_TUNNEL_PID, null)
    throw new Error(`Timed out waiting for trycloudflare URL. See ${LOG_PATH}`)
  }

  // Final probe (retry a few times — CF can flap for a few seconds)
  let ok = false
  for (let i = 0; i < 8; i++) {
    ok = await probeReachable(url)
    if (ok) break
    await sleep(1500)
  }
  if (!ok) {
    throw new Error(
      `Tunnel URL ${url} did not reach the local API (CF 530/1033). Retry start. Log: ${LOG_PATH}`
    )
  }

  setSetting(SETTING_PUBLISH_TUNNEL_BASE, url)
  if (proc.pid) setSetting(SETTING_PUBLISH_TUNNEL_PID, String(proc.pid))
  return getPublishTunnelStatus()
}

/** Manually set a tunnel URL (e.g. from an already-running cloudflared). */
export async function setPublishTunnelUrl(url: string): Promise<PublishTunnelStatus> {
  const base = (url || '').trim().replace(/\/$/, '')
  if (!base.startsWith('https://')) {
    throw new Error('Tunnel URL must be https://…')
  }
  const ok = await probeReachable(base)
  if (!ok) {
    throw new Error(`URL not reachable from this server: ${base}`)
  }
  setSetting(SETTING_PUBLISH_TUNNEL_BASE, base)
  return getPublishTunnelStatus()
}
