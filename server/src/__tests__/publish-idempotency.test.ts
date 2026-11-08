import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `pub-idem-${Math.random().toString(36).slice(2)}.db`,
)
process.env.PUBLIC_API_BASE = 'https://tunnel.example'

let db: typeof import('../db').default
let publishImageToInstagram: typeof import('../instagram-publish').publishImageToInstagram
let publishPostToInstagram: typeof import('../instagram-publish').publishPostToInstagram

const mediaCreates: string[] = []
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 1),
])

beforeAll(async () => {
  db = (await import('../db')).default
  ;({ publishImageToInstagram, publishPostToInstagram } = await import('../instagram-publish'))
})

afterEach(() => {
  mediaCreates.length = 0
  vi.unstubAllGlobals()
})

function stubGraph(opts: {
  existingStatus?: string
  failPublishOnce?: boolean
}) {
  let publishAttempts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method || 'GET').toUpperCase()
      const u = new URL(url)

      if (u.hostname === 'cdn.example') {
        return new Response(PNG, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }

      // Graph API
      if (u.hostname.includes('instagram.com') || u.hostname.includes('facebook.com')) {
        const path = u.pathname
        if (method === 'GET' && path.endsWith('/media_container_1')) {
          return Response.json({ status_code: opts.existingStatus || 'FINISHED' })
        }
        if (method === 'GET' && path.endsWith('/new_container')) {
          return Response.json({ status_code: 'FINISHED' })
        }
        if (method === 'GET' && path.endsWith('/published_media_1')) {
          return Response.json({
            id: 'published_media_1',
            permalink: 'https://instagram.com/p/x',
            shortcode: 'x',
            timestamp: new Date().toISOString(),
            media_type: 'IMAGE',
          })
        }
        if (method === 'POST' && path.endsWith('/media_publish')) {
          publishAttempts += 1
          if (opts.failPublishOnce && publishAttempts === 1) {
            return Response.json({ error: { message: 'temporary fail' } }, { status: 500 })
          }
          return Response.json({ id: 'published_media_1' })
        }
        if (method === 'POST' && path.endsWith('/media')) {
          mediaCreates.push(url)
          return Response.json({ id: 'new_container' })
        }
        if (method === 'GET' && path.includes('/insights')) {
          return Response.json({ data: [] })
        }
      }

      return Response.json({ error: { message: `unhandled ${method} ${url}` } }, { status: 500 })
    }),
  )
}

function fakeConn() {
  const accountId = `178414${Math.floor(Math.random() * 1e10)}`
  const info = db
    .prepare(
      `INSERT INTO instagram_conn (account_id, app_id, client_secret, redirect_uri, ig_username, status, access_token)
       VALUES (?, 'app', 'secret', 'http://localhost/cb', 'test', 'connected', ?)`,
    )
    .run(accountId, 'plain-token')
  return db
    .prepare('SELECT * FROM instagram_conn WHERE id = ?')
    .get(info.lastInsertRowid) as import('../instagram-oauth').IgConnRow
}

describe('publish idempotency', () => {
  it('reuses existing creation_id and does not create a second container', async () => {
    stubGraph({ existingStatus: 'FINISHED' })
    const conn = fakeConn()
    await publishImageToInstagram({
      conn,
      imageUrl: 'https://cdn.example/a.png',
      caption: 'hi',
      existingCreationId: 'media_container_1',
    })
    expect(mediaCreates).toHaveLength(0)
  })

  it('persists creation_id immediately and retry reuses it', async () => {
    const conn = fakeConn()
    const postId = Number(
      db
        .prepare(
          `INSERT INTO posts (status, format, hook, caption, image_url, version)
           VALUES ('staged', 'feed', 'h', 'c', 'https://cdn.example/a.png', 1)`,
        )
        .run().lastInsertRowid,
    )

    stubGraph({ failPublishOnce: true })
    await expect(
      publishPostToInstagram({
        conn,
        post: {
          id: postId,
          format: 'feed',
          image_url: 'https://cdn.example/a.png',
          caption: 'c',
        },
      }),
    ).rejects.toThrow(/temporary fail/)

    const row = db
      .prepare('SELECT instagram_creation_id FROM posts WHERE id = ?')
      .get(postId) as { instagram_creation_id: string }
    expect(row.instagram_creation_id).toBe('new_container')
    expect(mediaCreates).toHaveLength(1)

    mediaCreates.length = 0
    stubGraph({ existingStatus: 'FINISHED' })
    const result = await publishPostToInstagram({
      conn,
      post: {
        id: postId,
        format: 'feed',
        image_url: 'https://cdn.example/a.png',
        caption: 'c',
        instagram_creation_id: row.instagram_creation_id,
      },
    })
    expect(mediaCreates).toHaveLength(0)
    expect(result.creationId).toBe('new_container')
    expect(result.mediaId).toBe('published_media_1')
  })
})
