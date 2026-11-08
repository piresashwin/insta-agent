import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import os from 'os'

process.env.DB_PATH = path.join(
  os.tmpdir(),
  `studio-gen-${Math.random().toString(36).slice(2)}.db`,
)
process.env.IMAGE_OPENAI_API_KEY = 'test-key'

vi.mock('../media/openai-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media/openai-image')>()
  return {
    ...actual,
    openaiImageConfigured: () => true,
    generateOpenAiImageForPost: vi.fn(async (postId: number | string, prompt: string) => {
      const slug = prompt.replace(/\W+/g, '-').slice(0, 48)
      return {
        provider: 'openai' as const,
        model: 'test',
        absolutePath: `/tmp/${postId}-${slug}.png`,
        relativePath: `posts/${postId}/${slug}.png`,
        publicUrl: `https://cdn.example/posts/${postId}/${slug}.png`,
        mime: 'image/png',
        prompt,
      }
    }),
  }
})

let db: typeof import('../db').default
let studioGenerateJobOpts: typeof import('../services/studio-generate').studioGenerateJobOpts
let enqueueJob: typeof import('../jobs').enqueueJob
let claimJob: typeof import('../jobs').claimJob
let runJob: typeof import('../jobs').runJob
let getJob: typeof import('../jobs').getJob

beforeAll(async () => {
  db = (await import('../db')).default
  studioGenerateJobOpts = (await import('../services/studio-generate')).studioGenerateJobOpts
  const jobs = await import('../jobs')
  enqueueJob = jobs.enqueueJob
  claimJob = jobs.claimJob
  runJob = jobs.runJob
  getJob = jobs.getJob
})

function seedPost(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO posts (status, format, hook, caption, image_prompt, version)
         VALUES ('draft', 'feed', 'Morning brew', 'c', 'coffee steam', 1)`,
      )
      .run().lastInsertRowid,
  )
}

describe('studio generate-background / variations', () => {
  it('generate-background enqueues generate_media and writes a real asset URL', async () => {
    const postId = seedPost()
    const jobId = enqueueJob(
      studioGenerateJobOpts({
        postId,
        action: 'generate-background',
        brief: 'espresso bar',
      }),
    )
    const pending = getJob(jobId)!
    expect(pending.kind).toBe('generate_media')
    expect(pending.status).toBe('pending')
    expect(JSON.parse(pending.payload_json).studio_action).toBe('generate-background')

    const claimed = claimJob()
    expect(claimed?.id).toBe(jobId)
    await runJob(claimed!)

    const done = getJob(jobId)!
    expect(done.status).toBe('done')
    const result = JSON.parse(done.result_json!) as {
      assets: Array<{ url: string }>
      scene_json?: string
    }
    expect(result.assets[0].url).toMatch(/^https:\/\//)
    expect(result.assets[0].url).not.toMatch(/^prompt:\/\//)

    const asset = db
      .prepare(`SELECT url FROM assets WHERE post_id = ? ORDER BY id DESC LIMIT 1`)
      .get(postId) as { url: string }
    expect(asset.url).not.toMatch(/^prompt:\/\//)

    const post = db
      .prepare(`SELECT scene_json FROM posts WHERE id = ?`)
      .get(postId) as { scene_json: string }
    expect(post.scene_json).toContain(asset.url)
  })

  it('variations produces 4 distinct real assets', async () => {
    const postId = seedPost()
    const jobId = enqueueJob(
      studioGenerateJobOpts({
        postId,
        action: 'variations',
        brief: 'latte art',
      }),
    )
    const claimed = claimJob()!
    expect(claimed.id).toBe(jobId)
    await runJob(claimed)

    const done = getJob(jobId)!
    expect(done.status).toBe('done')
    const result = JSON.parse(done.result_json!) as {
      assets: Array<{ url: string; prompt: string }>
    }
    expect(result.assets).toHaveLength(4)
    const urls = new Set(result.assets.map((a) => a.url))
    expect(urls.size).toBe(4)
    for (const a of result.assets) {
      expect(a.url).not.toMatch(/^prompt:\/\//)
    }
  })
})
