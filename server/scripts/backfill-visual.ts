import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') })

import { getBrandProfile } from '../src/brand'
import { generateAndMaybePersistVisualIdentity } from '../src/brand-visual'
import { MCP_OPERATOR } from '../src/policy'

async function main() {
  const id = Number(process.argv[2] || 4)
  const before = getBrandProfile(id)
  console.log('before', id, !!before?.visual_identity)
  const r = await generateAndMaybePersistVisualIdentity(id, {
    persist: true,
    actor: MCP_OPERATOR,
  })
  console.log('after', !!r.brand.visual_identity)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
