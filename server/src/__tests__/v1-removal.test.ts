import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..', '..', '..')

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walkTsFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !name.includes('v1-removal')) out.push(full)
  }
  return out
}

describe('v1-removal guard', () => {
  it('deleted modules are gone', () => {
    expect(fs.existsSync(path.join(ROOT, 'server', 'src', 'media', 'still-bake.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'client', 'src', 'lib', 'canvas-export.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'client', 'src', 'lib', 'canvas-doc.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'client', 'src', 'components', 'PostCanvasEditor.tsx'))).toBe(false)
  })

  it('no source file imports the deleted modules', () => {
    const files = [
      ...walkTsFiles(path.join(ROOT, 'server', 'src')),
      ...walkTsFiles(path.join(ROOT, 'client', 'src')),
    ]
    const re = /from\s+['"][^'"]*(still-bake|canvas-export|canvas-doc|PostCanvasEditor)['"]/
    const hits: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      const m = text.match(re)
      if (m) hits.push(`${path.relative(ROOT, file)} → ${m[1]}`)
    }
    expect(hits).toEqual([])
  })
})
