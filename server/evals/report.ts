/**
 * Eval report writer — emits a JSON record and a human-readable Markdown
 * summary to evals/reports/<timestamp>.{json,md}.
 */
import fs from 'fs'
import path from 'path'

export interface TopicResult {
  fixture: string
  topic: string
  rep: number
  detPassed: boolean
  detFailures: string[]
  rubricScore: number | null
  leaks: string[]
  pairwiseWin: boolean | null
  error?: string
}

export interface EvalReport {
  startedAt: string
  pipeline: string
  baseline: string | null
  fixtures: string[]
  results: TopicResult[]
}

export interface FixtureSummary {
  fixture: string
  detPassPct: number
  rubricAvg: number | null
  pairwiseWinPct: number | null
  leakCount: number
}

export function summarize(report: EvalReport): FixtureSummary[] {
  const byFixture = new Map<string, TopicResult[]>()
  for (const r of report.results) {
    const arr = byFixture.get(r.fixture) ?? []
    arr.push(r)
    byFixture.set(r.fixture, arr)
  }

  const out: FixtureSummary[] = []
  for (const [fixture, rows] of byFixture) {
    const scored = rows.filter((r) => r.rubricScore != null)
    const paired = rows.filter((r) => r.pairwiseWin != null)
    out.push({
      fixture,
      detPassPct: rows.length ? (rows.filter((r) => r.detPassed).length / rows.length) * 100 : 0,
      rubricAvg: scored.length
        ? scored.reduce((s, r) => s + (r.rubricScore ?? 0), 0) / scored.length
        : null,
      pairwiseWinPct: paired.length
        ? (paired.filter((r) => r.pairwiseWin).length / paired.length) * 100
        : null,
      leakCount: rows.reduce((s, r) => s + r.leaks.length, 0),
    })
  }
  return out
}

function renderMarkdown(report: EvalReport, summary: FixtureSummary[]): string {
  const lines: string[] = []
  lines.push(`# Eval report — ${report.startedAt}`)
  lines.push('')
  lines.push('## Summary')
  lines.push(`- Fixtures run: ${report.fixtures.length}`)
  lines.push(`- Topics run: ${report.results.length}`)
  lines.push(`- Pipeline: ${report.pipeline}${report.baseline ? ` | Baseline: ${report.baseline}` : ''}`)
  lines.push('')
  lines.push('| Fixture | Det. pass% | Rubric avg | Pairwise wins | Leaks |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const s of summary) {
    lines.push(
      `| ${s.fixture} | ${s.detPassPct.toFixed(0)}% | ${
        s.rubricAvg != null ? `${s.rubricAvg.toFixed(1)} / 10` : '—'
      } | ${s.pairwiseWinPct != null ? `${s.pairwiseWinPct.toFixed(0)}%` : '—'} | ${s.leakCount} |`
    )
  }
  lines.push('')
  lines.push('## Target: ≥70% pairwise wins, 100% deterministic pass, 0 cross-brand leaks')
  lines.push('')

  const failures = report.results.filter((r) => !r.detPassed || r.leaks.length > 0 || r.error)
  lines.push('## Failures')
  if (!failures.length) {
    lines.push('None.')
  } else {
    for (const f of failures) {
      lines.push(`- **${f.fixture} / ${f.topic}** (rep ${f.rep})`)
      if (f.error) lines.push(`  - error: ${f.error}`)
      if (f.detFailures.length) lines.push(`  - checks: ${f.detFailures.join('; ')}`)
      if (f.leaks.length) lines.push(`  - cross-brand leak: ${f.leaks.join(', ')}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function writeReport(report: EvalReport, reportsDir: string): { json: string; md: string } {
  fs.mkdirSync(reportsDir, { recursive: true })
  const stamp = report.startedAt.replace(/[:.]/g, '-')
  const jsonPath = path.join(reportsDir, `${stamp}.json`)
  const mdPath = path.join(reportsDir, `${stamp}.md`)
  const summary = summarize(report)
  fs.writeFileSync(jsonPath, JSON.stringify({ ...report, summary }, null, 2))
  fs.writeFileSync(mdPath, renderMarkdown(report, summary))
  return { json: jsonPath, md: mdPath }
}
