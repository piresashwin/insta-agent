/**
 * Topic research skill — gathers facts/angles before content planning.
 * Prefer live web search when TAVILY_API_KEY or SERPER_API_KEY is set;
 * otherwise synthesizes from model knowledge (mode=model).
 *
 * Schema is intentionally flat (string arrays only) so local / Luna models
 * emit reliable JSON — nested objects were a frequent parse failure.
 */
import { z } from 'zod'
import { createStructuredModel } from './model'

export const TopicResearchSchema = z.object({
  query: z.string().describe('Search / research query used'),
  summary: z
    .string()
    .describe('One short paragraph (under 400 chars) on the topic for Instagram planning'),
  key_facts: z
    .array(z.string())
    .min(3)
    .max(8)
    .describe('Short factual bullets (under 120 chars each)'),
  angles: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe('Short Instagram content angles (under 100 chars each)'),
  hooks_to_avoid: z
    .array(z.string())
    .max(4)
    .default([])
    .describe('Cliché hooks to avoid (short phrases)'),
  source_lines: z
    .array(z.string())
    .max(6)
    .default([])
    .describe('Optional sources as plain lines: title | url | snippet'),
  mode: z.enum(['web', 'model']).describe('web = live search; model = knowledge-only'),
})

export type TopicResearch = z.infer<typeof TopicResearchSchema>

type ResearchArgs = {
  topic: string
  angle?: string | null
  pillar?: string | null
  brandGuide?: string | null
}

type WebHit = { title: string; url: string; snippet: string }

function researchConfigured(): { provider: 'tavily' | 'serper' | null } {
  if (process.env.TAVILY_API_KEY?.trim()) return { provider: 'tavily' }
  if (process.env.SERPER_API_KEY?.trim()) return { provider: 'serper' }
  return { provider: null }
}

async function searchTavily(query: string): Promise<WebHit[]> {
  const key = process.env.TAVILY_API_KEY!.trim()
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'basic',
      include_answer: false,
      max_results: 6,
    }),
  })
  if (!res.ok) {
    throw new Error(`Tavily search HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  return (json.results || [])
    .map((r) => ({
      title: (r.title || '').trim() || 'Untitled',
      url: (r.url || '').trim(),
      snippet: (r.content || '').trim().slice(0, 400),
    }))
    .filter((r) => r.snippet || r.url)
}

async function searchSerper(query: string): Promise<WebHit[]> {
  const key = process.env.SERPER_API_KEY!.trim()
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify({ q: query, num: 6 }),
  })
  if (!res.ok) {
    throw new Error(`Serper search HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>
  }
  return (json.organic || [])
    .map((r) => ({
      title: (r.title || '').trim() || 'Untitled',
      url: (r.link || '').trim(),
      snippet: (r.snippet || '').trim().slice(0, 400),
    }))
    .filter((r) => r.snippet || r.url)
}

async function fetchWebHits(query: string): Promise<{ hits: WebHit[]; provider: string } | null> {
  const { provider } = researchConfigured()
  if (!provider) return null
  try {
    const hits = provider === 'tavily' ? await searchTavily(query) : await searchSerper(query)
    if (!hits.length) return null
    return { hits, provider }
  } catch (err) {
    console.warn('[topic-research] web search failed:', (err as Error).message)
    return null
  }
}

function formatHits(hits: WebHit[]): string {
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n   URL: ${h.url || '(none)'}\n   ${h.snippet}`)
    .join('\n')
}


function jsonSafetyRules(): string {
  return `JSON rules (strict):
- Return ONLY one JSON object. No markdown, no commentary.
- Use double quotes for every key and string.
- Do NOT put raw line breaks inside strings; use spaces.
- Do NOT use curly/smart quotes.
- Keep every string short (summary < 400 chars; bullets < 120 chars).
- source_lines entries are plain strings like "Title | https://example.com | snippet".`
}

/** Produce a research brief for Instagram planning from a topic. */
export async function researchTopic({
  topic,
  angle,
  pillar,
  brandGuide,
}: ResearchArgs): Promise<TopicResearch> {
  const cleanTopic = (topic || '').trim() || 'general Instagram content'
  const queryParts = [cleanTopic]
  if (angle?.trim()) queryParts.push(angle.trim())
  if (pillar?.trim()) queryParts.push(pillar.trim())
  const query = queryParts.join(' — ')

  const web = await fetchWebHits(query)
  const model = createStructuredModel(TopicResearchSchema, { name: 'topic_research' })
  const mode: 'web' | 'model' = web ? 'web' : 'model'

  const baseContext = `Topic: ${cleanTopic}
${angle?.trim() ? `Preferred angle hint: ${angle.trim()}` : ''}
${pillar?.trim() ? `Content pillar: ${pillar.trim()}` : ''}
${brandGuide?.trim() ? `Brand notes: ${brandGuide.trim().slice(0, 600)}` : ''}`

  const prompt = web
    ? `You are a research analyst for an Instagram content team.
Synthesize the web results into a SHORT brief for a content planner.

${baseContext}

Live web results (${web.provider}):
${formatHits(web.hits)}

Ground key_facts in the results. Propose 3–5 Instagram-ready angles.
Set "mode" to "web". Set "query" to ${JSON.stringify(query)}.
Fill source_lines from the results when possible.

${jsonSafetyRules()}`
    : `You are a research analyst for an Instagram content team.
No live web search is configured. Use careful general knowledge only — no invented statistics or fake URLs.

${baseContext}

Produce a SHORT practical brief: what audiences care about + 3–5 strong content angles.
Set "mode" to "model". Set "query" to ${JSON.stringify(query)}.
Use an empty source_lines array [].

${jsonSafetyRules()}`

  return await model.invoke(prompt)
}

export function researchBriefToPromptBlock(research: TopicResearch): string {
  const facts = research.key_facts.map((f) => `- ${f}`).join('\n')
  const angles = research.angles.map((a) => `- ${a}`).join('\n')
  const avoid = (research.hooks_to_avoid || []).map((h) => `- ${h}`).join('\n')
  const sources = (research.source_lines || []).map((s) => `- ${s}`).join('\n')
  return [
    `Research mode: ${research.mode}`,
    `Query: ${research.query}`,
    '',
    'Summary:',
    research.summary,
    '',
    'Key facts:',
    facts,
    '',
    'Suggested angles:',
    angles,
    avoid ? `\nAvoid:\n${avoid}` : '',
    sources ? `\nSources:\n${sources}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export { researchConfigured }
