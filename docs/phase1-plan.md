# Phase 1 — Content Quality: Detailed Implementation Plan

Audit date: 2026-11-07. Based on a full read of the Phase 1 source files.

---

## What already exists (do not rebuild)

| File | What it does |
|---|---|
| `server/src/generation/pipeline.ts` | Full deterministic pipeline — research → plan → judge hook → media brief → caption → lint + rubric judge → ≤2 revision rounds. Returns `{ draft, review, trace }`. **Zero callers.** |
| `server/src/generation/brand-context.ts` | `resolveBrandContextV2(post)` reads DB for rubric, recent hooks, voice rules, example posts, hashtag sets, visual identity. `renderContext(ctx, sections, budget)` renders prompts within budget. `assertVisualIdentityReady(ctx)` throws 422 on empty palette. |
| `server/src/db/migrations/002_phase0.sql` | `post_reviews`, `post_versions`, `brand_rubrics`, `approvals`, `jobs`, `spend_ledger` tables. |
| `client/src/routes/PostScreen.tsx` | `RubricScorecard` (line 155), `HookAlternates` (line 121), `RequestChangesModal` with target picker. All components exist — but `getPostReview()` always returns null because nothing writes to `post_reviews`. |
| `client/src/components/BrandProfiles.tsx` | 1239-line component with voice_rules, example_posts, hashtag_sets, rubric CRUD, visual identity, palette — just needs section tabs. |

**Key insight:** The `fallbackResearch` mentioned in the original plan does not exist in the codebase. `topic-research.ts` already has proper web and model-knowledge modes. That item is a non-issue.

---

## Task 1 — Wire the pipeline into execution (BLOCKER)

**File:** `server/src/agent/start-run.ts`  
**Effort:** ~3 hours  
**Why first:** Every other Phase 1 quality item depends on the pipeline actually running. PostScreen scorecard already has the UI — it just always gets null data because nothing writes to `post_reviews`.

### What to change

`startAgentRunOnPost` currently fires this in its detached async block:

```typescript
// CURRENT (old path)
const ctx = await resolveBrandContext(post)          // v1 resolver
const result = await runAgent({ goal, topic, ... })  // ReAct loop
```

Replace with:

```typescript
// NEW (pipeline path — keep old path behind AGENT_MODE=loop)
if (process.env.AGENT_MODE === 'loop') {
  const ctx = await resolveBrandContext(post)
  const result = await runAgent({ goal, topic, ... })
  // ... existing mapping code stays here unchanged
} else {
  const ctx = await resolveBrandContextV2(post)
  assertVisualIdentityReady(ctx)  // throws 422 if palette/render_style missing

  const result = await runPipeline(ctx, {
    topic: post.topic ?? '',
    angle: post.angle ?? null,
    pillar: post.content_pillar ?? null,
    format: post.format as PostFormat,
    feedback: pendingRevisionNote ?? null,  // from iterations table
    onStep: (step) => emitRunEvent(runId, step),  // SSE
  })

  // Map PipelineDraft → seededVars (fields align closely)
  const patch = {
    caption:        result.draft.caption,
    hook:           result.draft.hook,
    hashtags:       result.draft.hashtags,
    alt_text:       result.draft.altText ?? null,
    agent_output:   JSON.stringify({
      research:        result.draft.research,
      research_mode:   result.draft.researchMode,
      research_sources: result.draft.researchSources,  // NEW — powers research badge
      hook_alternates: result.draft.altHooks,           // NEW — powers HookAlternates
      slides:          result.draft.slides ?? [],
      trace:           result.trace,
    }),
  }

  // Persist to post_reviews (scorecard already reads this in PostScreen)
  await db.run(
    `INSERT INTO post_reviews
       (post_id, post_version, rubric_version, judge_model, scores_json, items_json, passed, overall_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      post.id,
      post.version,
      ctx.rubric?.version ?? 0,
      result.review.judgeModel,
      JSON.stringify(result.review.rubricScores),
      JSON.stringify(result.review.critiqueItems),
      result.review.passed ? 1 : 0,
      result.review.overallScore,
    ]
  )

  await transitionPost(post, 'needs_review', patch)  // existing helper
}
```

### Also do in this task

- Read the pending `iterations` row for `feedback` before the pipeline call:
  ```typescript
  const pendingNote = await db.get(
    `SELECT note FROM iterations WHERE post_id = ? AND resolved_in_version IS NULL ORDER BY created_at DESC LIMIT 1`,
    [post.id]
  )
  ```
- After a revision round that improves the score, mark the iteration resolved:
  ```typescript
  await db.run(
    `UPDATE iterations SET resolved_in_version = ? WHERE post_id = ? AND resolved_in_version IS NULL`,
    [post.version + 1, post.id]
  )
  ```

### Imports to add at the top of start-run.ts

```typescript
import { resolveBrandContextV2, assertVisualIdentityReady } from '../generation/brand-context'
import { runPipeline } from '../generation/pipeline'
import type { PostFormat } from '@instagram-agent/shared'
```

---

## Task 2 — Persist PipelineReview + research sources in agent_output

This is part of Task 1 above but noted separately because it unblocks two distinct UI features:

1. **Scorecard shows real data** — `RubricScorecard` in PostScreen reads `review.rubricScores` from `getPostReview()`. That endpoint reads `post_reviews`. Once Task 1 inserts a row, the scorecard works with no UI changes.

2. **HookAlternates shows real alternates** — `HookAlternates` parses `post.hook_alternates`. The pipeline stores these in `result.draft.altHooks`. Writing them to `agent_output` (which PostScreen already parses) is enough.

3. **Research badge** — See Task 3 below.

---

## Task 3 — PostScreen additions (research badge, run link, version diff)

**File:** `client/src/routes/PostScreen.tsx`  
**Effort:** ~2 hours  
**Depends on:** Task 1 (pipeline must write researchSources)

### 3a. Research badge

The pipeline stores `researchMode` ("web" | "model_knowledge" | "none") and `researchSources[]` in `agent_output`. Add a small badge next to the hook/caption heading:

```tsx
// Parse from agentOutput (already loaded in PostScreen)
const researchMode = agentOutput?.research_mode ?? 'model_knowledge'
const researchSources = agentOutput?.research_sources ?? []

// Render
{researchMode === 'web' && researchSources.length > 0 ? (
  <span className="pill pill-positive text-xs">
    {researchSources.length} source{researchSources.length > 1 ? 's' : ''}
  </span>
) : researchMode === 'model_knowledge' ? (
  <span className="pill pill-warning text-xs" title="No live sources — model knowledge only">
    Unsourced
  </span>
) : null}
```

Sources list (collapsed by default):
```tsx
{researchSources.length > 0 && (
  <details className="mt-1">
    <summary className="text-[var(--muted)] text-xs cursor-pointer">Sources</summary>
    <ul className="mt-1 space-y-1">
      {researchSources.map((s, i) => (
        <li key={i} className="text-xs">
          <a href={s.url} target="_blank" className="text-[var(--accent)] hover:underline">{s.title}</a>
        </li>
      ))}
    </ul>
  </details>
)}
```

### 3b. Run link

The run_id is stored on the post. Add a small link in the Agent Notes section:

```tsx
{post.run_id && (
  <a href={`/activity?run=${post.run_id}`} className="text-xs text-[var(--muted)] hover:text-[var(--text)]">
    View run →
  </a>
)}
```

### 3c. Version diff

Add a `VersionDiff` component that shows what changed between the current version and the prior one.

**New endpoint needed:** `GET /api/posts/:id/versions` — already in the plan, reads `post_versions` table.

**New endpoint needed:** `GET /api/posts/:id/diff?from=N&to=M` — diffs two version snapshots.

For now, implement the simpler version: show the last iteration's note and what changed in caption/hook:

```tsx
function VersionDiff({ postId, currentVersion }: { postId: number, currentVersion: number }) {
  const { data } = useQuery({
    queryKey: ['post-versions', postId],
    queryFn: () => fetchPostVersions(postId),
    enabled: currentVersion > 1,
  })

  if (!data?.versions?.length || currentVersion <= 1) return null
  const prior = data.versions.find(v => v.version === currentVersion - 1)
  if (!prior) return null

  return (
    <div className="border border-[var(--border)] rounded-[var(--radius-card)] p-3 mt-3">
      <p className="text-xs font-semibold text-[var(--muted)] mb-2">Changes from v{prior.version}</p>
      {prior.note && (
        <p className="text-xs text-[var(--muted)] italic mb-2">"{prior.note}"</p>
      )}
      {prior.hook !== undefined && prior.hook !== data.current?.hook && (
        <div className="text-xs mb-1">
          <span className="text-[var(--negative)] line-through">{prior.hook}</span>
          <span className="ml-2 text-[var(--positive)]">{data.current?.hook}</span>
        </div>
      )}
    </div>
  )
}
```

Place `<VersionDiff postId={post.id} currentVersion={post.version} />` below the Agent notes scorecard.

---

## Task 4 — BrandScreen section tabs

**File:** `client/src/routes/BrandScreen.tsx`  
**Underlying component:** `client/src/components/BrandProfiles.tsx` (1239 lines)  
**Effort:** ~3 hours  
**Approach:** Restructure BrandProfiles.tsx into sub-panels; BrandScreen adds the section tab rail.

### Current state

`BrandScreen.tsx` is 15 lines that just render `<BrandProfilesPanel />`.  
`BrandProfiles.tsx` already has all the data fields — it just renders them in a single vertical scroll with no sections.

### Section structure

```
Basics   | name, niche, audience, pillars, goals, timezone, cadence
Voice    | voice description, do/don't rules, banned words, emoji policy, CTA styles,
         | example_posts manager (few-shot), hashtag_sets
Look     | palette (color swatches), fonts, render_style, shot_rules,
         | live swatch card (renders a sample caption in brand colors + fonts)
Rubric   | criteria list with weights, pass/fail examples; AI-generate button; editable
Advanced | scrim, margins, max_slides, visual_identity raw (collapsed)
```

### Implementation plan

1. **Extract sub-panels from BrandProfiles.tsx** — split into:
   - `BrandBasicsPanel` — lines ~1–200 of current form
   - `BrandVoicePanel` — includes `ExamplePostsManager` (new component)
   - `BrandLookPanel` — palette, fonts + new `BrandSwatchCard` preview
   - `BrandRubricPanel` — rubric CRUD (already exists in BrandProfiles.tsx)
   - `BrandAdvancedPanel` — collapsed raw fields

2. **Add tab rail to BrandScreen.tsx:**
   ```tsx
   const TABS = ['Basics', 'Voice', 'Look', 'Rubric', 'Advanced'] as const
   type BrandTab = typeof TABS[number]

   export function BrandScreen() {
     const [tab, setTab] = useState<BrandTab>('Basics')
     return (
       <div className="flex flex-col h-full">
         <div className="border-b border-[var(--border)] flex gap-6 px-6">
           {TABS.map(t => (
             <button key={t} onClick={() => setTab(t)}
               className={`py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                 tab === t ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--muted)]'
               }`}>{t}</button>
           ))}
         </div>
         <div className="flex-1 overflow-y-auto p-6">
           {tab === 'Basics'   && <BrandBasicsPanel />}
           {tab === 'Voice'    && <BrandVoicePanel />}
           {tab === 'Look'     && <BrandLookPanel />}
           {tab === 'Rubric'   && <BrandRubricPanel />}
           {tab === 'Advanced' && <BrandAdvancedPanel />}
         </div>
       </div>
     )
   }
   ```

3. **New: `ExamplePostsManager`** — few-shot example editor in the Voice tab:
   - Lists `brand.example_posts[]` (each has hook, caption, format, what_worked)
   - Add / edit / delete examples
   - "Generate from recent posts" button that calls a new `POST /api/brands/:id/example-posts/generate` endpoint

4. **New: `BrandSwatchCard`** — live preview in the Look tab:
   - A miniature post card (~280×350px) rendered in CSS using the brand's actual colors + fonts
   - Shows hook text in brand heading font on brand background color
   - Updates live as palette/font fields change (uses local form state, not saved value)
   - Gives the user immediate visual feedback on color choices

5. **AI generate flow** (already exists in BrandProfiles.tsx — preserve it):
   - Lock form while generating
   - Show field-by-field diff with Accept / Revert per field
   - Current behavior: overwrites without diff — this is the main improvement

---

## Task 5 — SetupScreen 5-step wizard

**File:** `client/src/routes/SetupScreen.tsx`  
**Effort:** ~2.5 hours  
**Purpose:** Shows on first run (until all 5 steps complete). Each step has a button, a done tick, and a skip.

### Steps

```
Step 1 — Create your brand with AI
  → Input: niche (text field)
  → Action: POST /api/brands/generate (exists)
  → Completion: brand exists with non-empty visual_identity
  → On complete: show diff of generated fields with Accept All

Step 2 — Check models work
  → Action: GET /api/health (shows each role: writer/judge/planner/vision)
  → Display: green tick per role, red X with model name on failure
  → Completion: all 4 roles reachable

Step 3 — Connect Instagram
  → Action: GET /api/instagram/connect-url → open OAuth URL
  → Completion: at least one ig_account row exists
  → Fallback: "Use mock account" (dev only, hides in prod)

Step 4 — Set monthly budget
  → Input: slider or number field ($1–$50, default $10)
  → Action: PATCH /api/settings { budget_monthly_usd }
  → Completion: app_settings.budget_monthly_usd is set

Step 5 — Generate your first week
  → Action: POST /api/brands/:id/fill-week (exists)
  → Shows: 7 proposal cards while generating (skeleton → real)
  → Completion: at least 3 posts exist with status 'draft' or later
```

### Component structure

```tsx
interface SetupStep {
  id: number
  title: string
  description: string
  isComplete: (data: SetupData) => boolean
  content: React.ReactNode
}

export function SetupScreen() {
  const [activeStep, setActiveStep] = useState<number>(0)
  const setupData = useSetupData()   // loads brands, health, accounts, budget, posts

  // Auto-advance to first incomplete step
  useEffect(() => {
    const first = steps.findIndex(s => !s.isComplete(setupData))
    if (first !== -1) setActiveStep(first)
  }, [setupData])

  if (steps.every(s => s.isComplete(setupData))) {
    return <Navigate to="/inbox" />  // all done — redirect
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-bold mb-1">Set up your page</h1>
      <p className="text-[var(--muted)] text-sm mb-8">Complete these steps to start generating posts.</p>
      {/* progress: "2 of 5" */}
      {steps.map((step, i) => <SetupStepCard key={i} step={step} active={i === activeStep} done={step.isComplete(setupData)} onActivate={() => setActiveStep(i)} />)}
    </div>
  )
}
```

### Show/hide logic

Show SetupScreen until all steps complete. Options:
- **Route guard** (simplest): in the router, redirect `/` → `/setup` if setup incomplete; check `useSetupComplete()` hook.
- Or: show a dismissible banner on Home if incomplete — less intrusive.

Recommend the route guard: matches the plan spec ("shown until complete").

---

## Task 6 — pnpm eval harness

**Directory:** `server/evals/`  
**Effort:** ~4 hours  
**Purpose:** Validates pipeline quality against 5 brand fixtures before shipping.

### Directory structure

```
server/evals/
  fixtures/
    01-faith.json         # existing brand data
    02-b2b-saas.json
    03-fitness-coach.json
    04-luxury-skincare.json
    05-local-bakery.json
  labels/
    pairs.json            # ~30 human-labeled good/bad pairs for judge calibration
  run.ts                  # main eval runner
  checks.ts               # deterministic checks (shared with pipeline)
  report.ts               # report writer (JSON + markdown)
  reports/                # gitignored output
```

### Fixture format

```typescript
interface EvalFixture {
  brand: Omit<BrandProfile, 'id'>    // voice, visual_identity, rubric, examples
  topics: string[]                    // 6 topics per brand
  gold_posts?: GoldPost[]             // 2-3 ideal posts per brand (optional)
}
```

### `run.ts` interface

```bash
pnpm eval                              # run all fixtures, all topics, 1 rep
pnpm eval --fixture 02-b2b-saas        # single fixture
pnpm eval --models writer=sonnet       # override model role
pnpm eval --prompt caption@v2          # override prompt version
pnpm eval --baseline                   # compare against old runAgent loop
pnpm eval --n 3                        # 3 reps per topic (averages scores)
```

### Deterministic checks (server/evals/checks.ts)

Move these out of pipeline.ts into a shared module so both eval and pipeline import them:

```typescript
export function runChecks(draft: PipelineDraft, ctx: BrandContextV2): CheckResult[] {
  return [
    checkFirstLineLength(draft.caption),     // ≤125 chars
    checkHashtagCount(draft.hashtags, ctx),   // within brand limit (default ≤5)
    checkBannedWords(draft.caption, ctx),     // brand's banned_words list
    checkBannedHashtags(draft.hashtags),      // #follow4follow etc.
    checkCTAPresent(draft.caption),           // at least one CTA
    checkOnImageWordCount(draft.slides),      // ≤12 words per slide
    checkEmojiPolicy(draft.caption, ctx),     // per brand emoji_policy
    checkDuplicateHook(draft.hook, ctx.recentHooks), // trigram Jaccard > 0.6
  ]
}
```

### Report output

```markdown
# Eval report — 2026-11-07T14:22:31Z

## Summary
- Fixtures run: 5
- Topics run: 30 (6 per fixture)
- Pipeline: main | Baseline: loop

| Fixture | Det. pass% | Rubric score avg | Pairwise wins |
| --- | --- | --- | --- |
| 01-faith | 100% | 7.8 / 10 | 73% |
| 02-b2b-saas | 100% | 8.1 / 10 | 81% |
| ...

## Target: ≥70% pairwise wins, 100% deterministic pass, 0 cross-brand leaks

## Failures
...
```

**LLM response cache:** Wrap `generateObject()` calls in an eval-aware cache:
```typescript
const cacheKey = hash({ model, prompt, system })
// reads from evals/.cache/<hash>.json if exists
// writes on first call
```

---

## Execution order (within Phase 1)

| # | Task | Effort | Unlocks |
|---|---|---|---|
| 1 | Wire pipeline.ts into start-run.ts | 3h | Everything |
| 2 | Persist PipelineReview + research sources | 1h | Scorecard, HookAlternates, badge |
| 3 | PostScreen: research badge + run link | 1h | Reviewer sees sources |
| 4 | PostScreen: version diff panel | 1.5h | Reviewer sees what changed |
| 5 | BrandScreen: section tabs + sub-panels | 3h | Brand setup UX |
| 6 | BrandScreen: ExamplePostsManager | 1.5h | Few-shot examples |
| 7 | BrandScreen: BrandSwatchCard | 1h | Live visual preview |
| 8 | SetupScreen 5-step wizard | 2.5h | Onboarding |
| 9 | pnpm eval harness | 4h | Quality validation |

**Total: ~18.5 hours** across two back-end sessions (tasks 1–2) and two front-end sessions (tasks 3–8) plus an eval session (task 9).

---

## Exit criteria

- `pnpm typecheck` and `pnpm test` pass
- `GET /api/posts/:id/review` returns a non-null review for a post run through the pipeline
- PostScreen scorecard shows real rubric scores
- Approving a post whose review score < 7 shows an override-reason prompt
- Brand screen has 5 section tabs; Look tab shows live swatch card
- Setup screen shows on first run and redirects to /inbox on completion
- `pnpm eval --baseline` shows ≥70% pairwise wins and 100% deterministic pass
- No cross-brand content leaks (faith content never appears in SaaS fixture output)
