# Idea → Post flow ("Explore → Shortlist → Craft"): implementation plan

Status: ready for implementation. Produced via `/feature-planning` from
`/Users/ashwin/.claude/plans/the-goal-of-this-sleepy-hearth.md`. File/line citations
were re-verified against `/Users/ashwin/dev/instagram-agent` on **2026-11-08** (afternoon).
Working tree still has ~118 uncommitted paths — **recheck line numbers before each edit**.

**Context vs phases.** Phases 0–4 engine work (including Insights / `011_phase4_insights.sql`)
is present in the tree. This feature is the product gap the master plan’s creative workflow
describes: Explore → Shortlist → Craft. It is **not** Phase 5 MCP polish. MCP idea tools stay
out of scope here.

---

## 1. Feature overview

**The problem.** "Fill week" on the Calendar creates empty `draft` posts, and after that nothing
on a mounted screen can generate content for them.
- `POST /api/brand-profiles/:id/fill-week` (`server/src/fill-week.ts:105-117`) only inserts rows
  (via `createDraftFromProposal` in `server/src/brand.ts:419-456`).
- No mounted screen can start an agent run on an existing draft. `PostScreen.tsx` action bar
  (`:841+`) only offers approve / request-changes / approve-media — not "Write draft".
- The only Generate / Generate media buttons live in `client/src/components/PostStudio.tsx`,
  which is rendered only by the unmounted `Dashboard.tsx` (grep: only those two files import
  `PostStudio` / `CalendarWeekPanel`).
- "Request changes" (`server/src/http/routes/post-actions.ts:114-206`) never starts a run.
- Setup's "Generate first week" calls `fillWeek(brand.id, { week_start })` without
  `dry_run: false` (`SetupScreen.tsx:533`). Server `fillWeekForBrand` defaults
  `dry_run = opts.dry_run !== false` (`fill-week.ts:45`) → **preview only, zero posts created**.

**What the operator wants** is a creative workflow, not a batch job:
1. **Explore:** generate many cheap ideas, steer them, riff on good ones, add your own.
2. **Shortlist:** star the good ones and place them on days of the week. Placing creates an empty draft and costs nothing.
3. **Craft:** work on each post one at a time. Pick a hook sketch, give the writer a direction, and write the draft. Then revise, approve the copy, make the visual (generate or design in Studio), approve it, and the post is scheduled.

**What gets built:**
- A persistent `ideas` backlog and an idea-generation skill.
- A new **Plan** screen.
- PostScreen turned into a guided craft workspace.
- Pipeline seeding from the chosen idea.
- An auto-rerun option on "Request changes".
- Two job-runner reliability fixes that honest progress display depends on.
- Small fixes to broken client calls.

## 2. Requirements

### Functional

- **F1 — Generate ideas.** For a selected brand, generate a batch of N ideas (default 8, max 12), optionally steered by free text, a pillar and a format.
  - Each idea has a topic, an angle, a pillar, a format, 2–3 hook sketches, and a one-line "why".
  - Ideas are stored, grouped by batch, and shown newest batch first with the steer text as the batch label.
  - The button shows its cost.
- **F2 — Riff.** "Riff" on an idea generates 3 variations linked to the parent (`source='riff'`, `parent_idea_id`).
- **F3 — Manual idea.** The operator can add an idea by hand. Topic is required; angle, pillar, format and hooks are optional.
- **F4 — Curate.** Ideas can be shortlisted, dismissed, or restored to `new`.
  - Board tabs: **Board** (new + shortlisted), **Shortlist**, **Dismissed**.
  - Ideas persist across weeks.
- **F5 — No repeats.** Generated ideas whose topic or any hook sketch is a near-duplicate (trigram Jaccard > 0.6) of a recent published hook or of an existing non-dismissed idea's topic or hooks are discarded. The response reports how many were dropped.
- **F6 — Cadence (board-only Plan).** Plan is an idea board, not a week editor. A muted cadence line shows `N of posts_per_week this week` (current week via `listCalendar`). No day grid, week nav, or drag-drop on Plan. Week grid lives on Calendar. Refined further in [`docs/features/plan-surface-riff/IMPLEMENTATION.md`](../plan-surface-riff/IMPLEMENTATION.md).
- **F7 — Schedule.** Putting an idea on a day via the **Add to day…** selector on an idea card creates a `draft` post with the idea's topic, angle, pillar and format on that date, linked through `posts.idea_id`. The idea becomes `scheduled`. No LLM call, no spend. Options are the current calendar week (Mon–Sun).
- **F8 — Unschedule.**
  - A scheduled idea whose post is untouched can be unscheduled: the draft is deleted and the idea goes back to `shortlisted`.
  - Untouched means: status `draft`, no hook, no caption, no runs, no iterations.
  - If the post was touched, the request is refused with "This post is already being crafted — open it instead".
- **F9 — Idea panel on the post.** PostScreen shows the source idea (angle, why, hook sketches).
  - While the post is `draft` or `changes_requested`, the operator can pick a hook sketch (or none) and write a "Direction for the writer". Both are saved to the idea.
- **F10 — Write draft.**
  - For `draft` posts, **Write draft** starts an agent run. The pipeline uses the chosen hook as the starting hook and the direction as instructions.
  - A progress strip shows run status and the latest step. When the run finishes, the screen reloads and shows the new copy.
- **F11 — Revise with notes.** From `pending_approval`, the composer (with a target: hook, caption, visual or hashtags) records the note and **immediately re-runs the agent**. If the revision cap is reached (`needs_revision`), no run starts and the screen says why, with a "Restart to draft" action.
- **F12 — Try new hooks.** From `pending_approval`, **Try new hooks** calls the existing `alternate-hooks` studio action. The returned hooks appear as swappable alternates (swapping reuses `patchPost({hook})`).
- **F13 — Visuals.**
  - From `approved`: **Generate visual** (with cost) enqueues `generate_media`. Progress shows until the job ends, then the screen reloads.
  - **Design in Studio** opens `/studio/$postId`.
  - From `media_ready`: **Approve visuals** (existing approve-media) and **Regenerate visual**.
  - `staged` shows "Scheduled for <date>".
- **F14 — Calendar.** "Fill week" / "Create drafts" are replaced by **Plan this week**, which navigates to `/plan`. Post cards show the next-step label.
- **F15 — Setup.** The "Generate first week" step becomes **Plan your first week**, which navigates to `/plan`. Its completion rule is unchanged (≥3 posts).
- **F16 — Navigation.** The sidebar gets a **Plan** item between Inbox and Calendar. Home's "Plan more posts" links to `/plan`.

### Technical

- **T1.** An `agent_run` job finishes only after the run's work finishes, so jobs execute one at a time and job status is truthful. If the run cannot start inside the worker, the pre-created run is closed as `failed`.
- **T2.** The stale-run sweeper never fails a run whose `agent_run` job is still `pending` or `running`, both at boot and on the 10-minute sweep.
- **T3.** The client `estimateCost` calls the real endpoint `POST /api/budget/estimate` (today it calls `/api/estimate`, which 404s silently).
- **T4.** The client `generateMedia` return type matches the server's 202 `{ job_id, post, note }`.
- **T5.** The trigram near-duplicate helper moves into `server/src` and `server/evals/checks.ts` imports it from there. One implementation.
- **T6.** `POST /api/brand-profiles/:id/fill-week` and MCP `fill_week` / `start_run_on_post` behave exactly as before.

## 3. Existing implementation analysis (verified 2026-11-08)

### Server

**Migrations**
- Migrations live under `server/src/db/migrations/`; runner sorts by filename prefix and
  swallows `already exists` / `duplicate column` errors.
- Latest file: **`011_phase4_insights.sql`**. Next: **`012_ideas.sql`** — no other runner change.
- There is **no** `ideas` table and **no** `posts.idea_id` today (repo-wide grep clean).
- `iterations.target` already exists (`001_baseline.sql:85`, reinforced in `008_fix_activity_runs.sql:9`)
  but `request-changes` does **not** write it (`post-actions.ts:179-181`).

**LLM**
- `generateObject(opts)` (`server/src/llm/adapter.ts:51`) takes `{ role: 'writer'|'judge'|'planner'|'vision', schema, system, prompt, schemaName?, postId?, skill?, promptRef?, maxOutputTokens?, brandContext? }`.
  - It returns `{ data, usage, provider, model, costUsd }`.
  - It logs `skill_runs` when `skill` is set, and writes `spend_ledger` when `costUsd > 0`.
  - It delegates to `createStructuredModel` (dynamic import of `../skills/model`, `adapter.ts:73-77`).
- **Test precedent:** `server/src/__tests__/phase4-week-plan.test.ts:7-13` mocks `../skills/model` (`createStructuredModel: () => ({ invoke })`). That also covers `generateObject`.

**Brand context** (`server/src/generation/brand-context.ts`)
- `resolveBrandContextV2(post: Post)` (`:121-165`) needs a Post-shaped object. Verified field reads:
  `brand_profile_id`, `brand_overrides`, `background_style`, `format` (plus
  `loadPerformanceSummary(post.brand_profile_id)` for Phase 4).
- `BrandContextV2.recentHooks` from private `getRecentHooks`.
- `renderContext(ctx, sections, budget)`. Section names:
  `voice|examples|audience|hashtags|visual|rubric|hooks_memory|research|performance`.

**Pipeline**
- `PipelineOpts` (`server/src/generation/pipeline.ts:80-87`) is
  `{topic, angle?, pillar?, format?, feedback?, onStep?}`.
- Plan step (`:169+`) calls `planContent` (`server/src/skills/content-planning.ts`).
  - `PlanContentArgs` (`:30-42`); prompt template includes feedback near `:148`.
- Hook judging runs only when `ctx.rubric` is set. **Decision:** seed through the plan prompt
  only — do not change `HookPickSchema`.

**Agent run** (`server/src/agent/start-run.ts`)
- `startAgentRunOnPost(postId, {initiator?, inline?, existingRunId?})` (`:74`) is synchronous.
- `StartAgentRunResult` (`:51-56`) is `{ post, run_id, job_id?, note }` — **no `done` promise today**.
- Inline path: fire-and-forget `void (async () => {…})()` at **`:194`**, returns immediately.
- Pipeline branch: loads `latest` (`:423`), `runPipeline` (`:430-442`) — seed hooks/direction go here.
- `canStartAgentRun` (`orchestrator.ts:294-295`) allows `draft` | `changes_requested`.

**Job runner** (`server/src/jobs.ts`)
- `handleAgentRun` (`:201-219`) calls `startAgentRunOnPost(..., {inline:true, existingRunId})` and
  returns `{ run_id, note }` **without awaiting the inline work** → job marked `done` immediately.
- `runJob` (`:318+`) renews lease every 10s while the handler is awaited.
- Worker `busy` flag serialises jobs only while handlers are awaited — so T1 (await `done`) is required
  for truthful progress and one-at-a-time agent runs.

**Runs** (`server/src/runs.ts`)
- `failStaleRuns(maxAgeMs)` (`:122-147`) selects `status='running'` runs by age (or all when
  `maxAgeMs<=0`) and **does not consult `jobs`**. Boot call still present in `server.ts`.
- `completeRun` / `getRun` exist and are the right hooks for S10.

**Request changes** (`server/src/http/routes/post-actions.ts:114-206`)
- Body `{ author, comment }` only; `author.id` required.
- Inserts `iterations(post_id, author, comment)` — no `target`.
- Transitions to `changes_requested` or `needs_revision` at `MAX_REVISIONS`.
- Does **not** start a run. Allowed from `pending_approval` via `VALID_TRANSITIONS`.

**Fill week and policy**
- `fill-week.ts:48-54` uses `calendar.plan` / `calendar.commit` on `{type:'brand', brand}`.
- After insert, `fill-week.ts:111-113` calls `assertAllowed(actor, 'post.draft', { type: 'post', post })`.
- **Verified constraint:** `policy.ts:161-163` rejects non-post resources for post actions;
  `post.draft` case is a no-op allow at `:273-274`. Therefore `scheduleIdea` **cannot** check
  `post.draft` against a brand resource — mirror fill-week: insert inside a transaction, then
  `assertAllowed(..., {type:'post', post})`, rollback on deny.
- Brand/calendar actions require human `actor.id` (`policy.ts:148-158` path for brand resources).
- `actorFromRequest` (`policy.ts:333`). `ApiError` in `orchestrator.ts`; `sendApiError` in
  `http/helpers.ts`.

**Budget**
- `monthlyCap()` / `monthlySpend()` (`budget.ts:42,46`); `budgetAwareFormatMix` (`:254+`).
- Estimate route: `budgetRouter.post('/estimate')` (`http/routes/budget.ts:102-133`), mounted at
  **`/api/budget`** (`server.ts:232`) → real path **`POST /api/budget/estimate`**.
  Kinds: `agent_run` 0.05, `generate_image` 0.02, `generate_reel`, `fill_week`, default 0.01.
- Client still calls **`/api/estimate`** (`api.ts:739-741`) → silent 404 (T3).

**Media and studio**
- `POST /api/posts/:id/generate-media` returns `202 { job_id, post, note }` (`media.ts:59+`).
- Client `generateMedia` return type omits `job_id` (`api.ts:307-318`) — T4.
- Alternate hooks studio action exists (client `studioAction` around `api.ts:835+`).

**Near-duplicate helper**
- Only in `server/evals/checks.ts`: private `trigrams` (`:21`), `jaccard` (`:28`), threshold `> 0.6`.

**MCP (compatibility)**
- `fill_week` in `mcp-operator-tools.ts`; `start_run_on_post` / `run_content_pipeline` in
  `mcp-server.ts`. Must keep behaviour (T6). Embedded inline path ignores any future `done` field.

**Route test harness**
- Temp `DB_PATH` + dynamic import + `express().listen(0)` + `fetch`
  (`server/src/__tests__/phase4-insights-routes.test.ts`). No supertest.

### Client

**api.ts**
- `request<T>` throws `Error(body.error)` on non-2xx; actor is `DEV_OPERATOR`.
- Confirmed helpers: `agentRun`, `approvePost`, `requestChanges(postId, comment)` (`:154` — no
  `target`/`rerun`), `restartPost`, `getPost`, `patchPost`, `listBrandProfiles`,
  `generateMedia` (`:307`, return type missing `job_id`), `listCalendar`, `approveMedia`,
  `getRun`, `listJobs`/`getJob`, `estimateCost` (`:739` → wrong `/api/estimate`), `studioAction`.

**PostScreen** (`client/src/routes/PostScreen.tsx`, ~902 lines after Phase 4)
- `useState` + `reload()` (`:385+`). **No react-query** — keep it that way (tests have no
  `QueryClientProvider`).
- Tabs include **`performance`** (`:69`) for published posts — **preserve** when adding craft UI.
- Action bar (`:841+`): `approve-copy` / `approve-media` / request-changes only.
- `RequestChangesModal` (`:246+`) has a target picker but only prefixes `[Target]` into comment text.
- Jobs appear in History tab; no run-progress strip for agent_run today.
- Also embedded from Inbox.

**StudioScreen**
- Run-poll pattern in `GeneratingScreen` (~`:748-770`) is the UX precedent for S14/S15.
- `/studio/$postId` opens the editor.

**CalendarScreen** (`client/src/routes/CalendarScreen.tsx`)
- Local brand/week state; week helpers `mondayOf` / `isoDay` / `addDays` / `weekLabel` (`:19-41`).
- `handleFillWeek` (`:408`), header Fill week button (`:547`), proposals panel still present.
- No shared client brand context.

**Routing and shell**
- `router.ts`: lazy routes + `routeTree` (`:102-116`). **No `/plan` route.**
- `Shell.tsx` `NAV_ITEMS` (`:19-27`): Home, Inbox, Calendar, Studio, Insights, Brand, Activity —
  **no Plan**.

**Home / Setup**
- Home "Plan more posts" → `/calendar` (`HomeScreen.tsx:458-463`).
- Setup `StepFirstWeek` still calls `fillWeek` without `dry_run:false` (`:533`); button
  "Generate first week" (`:558`). Completion still `postCount >= 3`.

**post-studio-actions.ts**
- `resolveStudioPrimary` + carousel gates. **Only importer:** dead `PostStudio.tsx`.

**Dead screens (S18)**
- `Dashboard.tsx`, `PostStudio.tsx`, `CalendarWeek.tsx` — not in router; safe to delete after
  stash/commit and a final grep. Leave `PostDialog` / `layout` / `ui/dialog` alone.

**UI primitives**
- Button, Badge, Card, Input, Label, native Select, Separator, Table, `sonner`.
- No Tabs/Menu/Tooltip/Radix/DnD library — button groups, native `<select>`, HTML5 drag-drop.

**Client test pattern**
- `vi.mock('../api')` + router mocks; `QueryClientProvider` only when the screen uses react-query
  (`StudioScreen.entry.test.tsx`). PostScreen tests stay without it.

## 4. Proposed technical approach

- **Ideas are a new domain.** One table, one service (`server/src/services/ideas.ts`), one skill (`server/src/skills/idea-generation.ts`), one router mounted at `/api/ideas`.
  - Scheduling reuses `createDraftFromProposal`, so drafts are identical to what Fill week creates today, plus `idea_id`.
- **Seeding stays read-time.** `posts.idea_id` points at the idea. `start-run.ts` reads the idea's `chosen_hook` and `direction` when the pipeline runs, so edits made right before "Write draft" always apply. Nothing new goes into the job payload.
- **PostScreen stays on its `reload()` pattern.** Progress uses a small polling hook (`setInterval`), not react-query, to keep `PostScreen.test.tsx` valid.
- **One resolver for next steps.** `resolveNextStep(post, slides)` in `client/src/lib/post-studio-actions.ts` decides primary and secondary actions per status. PostScreen, PlanScreen strip cards and Calendar cards all use it.
- **Plan screen state.** It uses react-query (like CalendarScreen) with local brand and week state. The week helpers are extracted from CalendarScreen into `client/src/lib/week.ts` and shared.
- **Job fix.** The inline agent path returns a `done` promise. `handleAgentRun` awaits it, which serialises runs and makes job status truthful. The sweeper ignores runs with live jobs.
- **Security.** All new mutating routes go through `assertAllowed`, using the existing actions:

  | Operation | Policy actions |
  |---|---|
  | generate, create, update | `calendar.plan` on `{type:'brand', brand}` |
  | schedule, unschedule | `calendar.commit` + `post.draft` (`post.draft` checked **before** inserting) |

  Ideas are always looked up together with their `brand_profile_id`. A `like_idea_id` from another brand gets a 400.
- **Backward compatibility.**
  - The new `request-changes` fields (`target`, `rerun`) are optional; omitting them keeps today's behaviour exactly.
  - Fill-week REST/MCP and `start_run_on_post` are untouched.
  - The new `StartAgentRunResult.done` is optional.

## 5. Detailed implementation steps

Each step lists file, change, result and dependencies. **Run `pnpm --filter shared build` after any `shared/src` change** before typechecking server or client.

### S1 — Migration (no dependencies)

Create `server/src/db/migrations/012_ideas.sql`:

```sql
CREATE TABLE IF NOT EXISTS ideas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_profile_id INTEGER NOT NULL,
  batch_id         TEXT,
  topic            TEXT NOT NULL,
  angle            TEXT,
  pillar           TEXT,
  format           TEXT NOT NULL DEFAULT 'feed',
  hooks_json       TEXT NOT NULL DEFAULT '[]',
  chosen_hook      TEXT,
  direction        TEXT,
  why              TEXT,
  source           TEXT NOT NULL DEFAULT 'ai',      -- ai | manual | riff
  parent_idea_id   INTEGER,
  steer            TEXT,
  status           TEXT NOT NULL DEFAULT 'new',     -- new | shortlisted | dismissed | scheduled
  post_id          INTEGER,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ideas_brand_status ON ideas(brand_profile_id, status);
ALTER TABLE posts ADD COLUMN idea_id INTEGER;
```

Result: the tables exist on the next server or test boot.

### S2 — Shared types (no dependencies)

In `shared/src/index.ts`:
- Add `export type IdeaStatus = 'new'|'shortlisted'|'dismissed'|'scheduled'`.
- Add `export type IdeaSource = 'ai'|'manual'|'riff'`.
- Add `export type Idea = { id; brand_profile_id; batch_id: string|null; topic; angle: string|null; pillar: string|null; format: PostFormat; hooks: string[]; chosen_hook: string|null; direction: string|null; why: string|null; source: IdeaSource; parent_idea_id: number|null; steer: string|null; status: IdeaStatus; post_id: number|null; created_at: string; updated_at: string|null }`. Note `hooks` is parsed from `hooks_json` on the server.
- Add `idea_id?: number | null` to `Post` (`:306-360`).
- Rebuild shared.

### S3 — Near-duplicate helper (no dependencies)

- Create `server/src/generation/similarity.ts` exporting:
  - `trigrams(s)` and `jaccard(a, b)`, moved verbatim from `server/evals/checks.ts:21-34`.
  - `isNearDuplicate(a: string, b: string, threshold = 0.6): boolean`, which returns `jaccard(trigrams(a), trigrams(b)) > threshold`.
- Edit `server/evals/checks.ts` to import `trigrams` and `jaccard` from `../src/generation/similarity` and delete the local copies.
- Result: behaviour is identical and `evals/checks.test.ts` still passes.

### S4 — Brand context for a brand id (no dependencies)

In `server/src/generation/brand-context.ts`, export `resolveBrandContextForBrand(brandProfileId: number): BrandContextV2`.
- It calls `resolveBrandContextV2` with a minimal Post-shaped object: `{ id: 0, brand_profile_id: brandProfileId, format: null, brand_overrides: null, background_style: null } as unknown as Post`.
- Confirm by reading `resolveBrandContextV2` that no other Post field is dereferenced. If one is, add it with a null value.

### S5 — Idea-generation skill (depends on S3, S4)

Create `server/src/skills/idea-generation.ts`:

- **Schema** (zod): `IdeaBatchSchema = z.object({ ideas: z.array(z.object({ topic: z.string().min(3).max(200), angle: z.string().max(300), pillar: z.string().nullish(), format: z.enum(['feed','reel','carousel']), hooks: z.array(z.string().max(150)).min(2).max(3), why: z.string().max(200) })).min(1).max(12) })`.
- **Signature:** `export async function generateIdeas(opts: { brandProfileId: number; count: number; steer?: string|null; pillar?: string|null; format?: PostFormat|null; likeIdea?: { topic: string; angle: string|null; hooks: string[] } | null; avoidTopics: string[]; allowReels: boolean }): Promise<IdeaBatch['ideas']>`.
- **Context:**
  - `ctx = resolveBrandContextForBrand(id)`.
  - `brandContext = renderContext(ctx, ['voice','audience','examples','hooks_memory','performance'], 3000)`.
  - Pillars come from the brand profile (`getBrandProfile`, `server/src/brand.ts`). Parse them the same way `fill-week.ts` does.
- **LLM call:** `generateObject({ role: 'planner', schema: IdeaBatchSchema, schemaName: 'idea_batch', skill: 'idea_generation', brandContext, maxOutputTokens: 1200, system, prompt })`.
- **System prompt:** "You are a creative strategist brainstorming Instagram post ideas for this brand. Ideas must be distinct from each other (different angles, not rewordings), native to Instagram, true to the brand voice, and spread across the brand's pillars unless a pillar is requested. Hooks: ≤125 characters, no unverifiable statistics."
- **User prompt** lists:
  - the count;
  - the steer (if any);
  - the requested pillar and format (if any);
  - `allowReels === false` → "Do not suggest reels.";
  - if `likeIdea` is set: "Riff on this idea — give variations that keep its core but change the angle, format or hook: …";
  - "Avoid these existing topics: …" (`avoidTopics`, at most 40, each ≤120 chars).
- **Post-processing:**
  - When `!allowReels`, map `format: 'reel'` to `'feed'`.
  - Trim strings.
  - Truncate to `count`.

### S6 — Ideas service (depends on S1, S2, S3, S5)

Create `server/src/services/ideas.ts`. It uses `db` from `../db`, `ApiError` from `../orchestrator`, and `createDraftFromProposal` / `getBrandProfile` from `../brand`.

- `rowToIdea(row)`: parses `hooks_json` with a safe fallback to `[]`.
- `listIdeas(brandProfileId, status?: IdeaStatus | 'board')`: `'board'` means `status IN ('new','shortlisted')`. Ordered `created_at DESC, id DESC`.
- `getIdea(id)`: throws `ApiError(404,'idea not found')`.
- `generateIdeaBatch(brandProfileId, { count=8, steer, pillar, format, likeIdeaId })`:
  1. Brand must exist (404).
  2. If `likeIdeaId` is set, load it. It must have the same `brand_profile_id` (400 `'like_idea_id belongs to another brand'`). The riff count is fixed at 3.
  3. `remaining = monthlyCap() - monthlySpend('prod')`.
  4. `allowReels = (budgetAwareFormatMix(parsedMix, remaining).reel ?? 1) > 0`, using the same mix parsing as `fill-week.ts:65-70`.
  5. `avoid` = topics + hooks of the brand's non-dismissed ideas + `resolveBrandContextForBrand(id).recentHooks`.
  6. Call `generateIdeas`.
  7. Drop any idea whose topic or any hook `isNearDuplicate` with any `avoid` entry, or with an idea already kept in this batch.
  8. Insert the survivors with a shared `batch_id = crypto.randomUUID()`, `source = likeIdeaId ? 'riff' : 'ai'`, `parent_idea_id`, `steer`, `status='new'`, `updated_at=CURRENT_TIMESTAMP`.
  9. Return `{ batch_id, ideas, dropped }`.
- `createManualIdea(brandProfileId, input)`: `source='manual'`, `status='shortlisted'` (a hand-written idea is already wanted).
- `updateIdea(id, patch)`:
  - Allowed fields: `topic`, `angle`, `pillar`, `format`, `chosen_hook`, `direction`, `status`.
  - `status` must be `new|shortlisted|dismissed`.
  - If the idea is `scheduled`, changing `status`, `topic`, `angle`, `pillar` or `format` gives 409 `'Idea is scheduled — unschedule it or edit the post'`. `chosen_hook` and `direction` stay editable.
- `scheduleIdea(id, { date, account_id }, actor)`:
  1. Idea status must be `new` or `shortlisted` (409 otherwise).
  2. `date` must match `^\d{4}-\d{2}-\d{2}$` and be a real date (400).
  3. Run `assertAllowed(actor,'calendar.commit',{type:'brand',brand})` **before** inserting.
  4. Inside `db.exec('BEGIN IMMEDIATE')` … `COMMIT` (with `ROLLBACK` on error):
     - `post = createDraftFromProposal({ brand_profile_id, account_id: account_id ?? null, proposal: { date, topic, pillar, format, angle } })`
     - then `assertAllowed(actor,'post.draft',{type:'post', post})` — **required**: policy only
       accepts post resources for `post.draft` (`policy.ts:161-163`, same pattern as
       `fill-week.ts:111-113`). On deny, throw so the transaction rolls back.
     - `UPDATE posts SET idea_id=? WHERE id=?`
     - `UPDATE ideas SET status='scheduled', post_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  5. Return `{ idea, post: getPost(post.id) }`.
- `unscheduleIdea(id, actor)`:
  1. The idea must be `scheduled` with a `post_id` (409 otherwise). Run `assertAllowed(actor,'calendar.commit',…)`.
  2. Load the post. If it's missing, just reset the idea.
  3. **Untouched** means: `status='draft' AND hook IS NULL AND caption IS NULL`, and no rows in `runs` or `iterations` for that `post_id`. If touched, 409 `'This post is already being crafted — open it instead'`.
  4. In one transaction:
     - delete from `post_slides`, `iterations`, `post_versions` and `post_proposed_versions` where `post_id=?`, then `posts` where `id=?` (verify each table has a `post_id` column; skip any that doesn't);
     - set the idea back to `status='shortlisted', post_id=NULL`.

### S7 — Ideas router (depends on S6)

Create `server/src/http/routes/ideas.ts` with `export const ideasRouter = Router()`. Mount it in
`server/src/server.ts` next to the other routers (after insights is fine):
`app.use('/api/ideas', ideasRouter)` near `server.ts:220-238`, and add the paths to the `/api`
index listing.

| Method | Path | Body or query | Policy | Response |
|---|---|---|---|---|
| GET | `/` | `?brand_profile_id=&status=new\|shortlisted\|dismissed\|scheduled\|board` | none (read) | `{ideas}` |
| POST | `/generate` | `{brand_profile_id, count?, steer?, pillar?, format?, like_idea_id?, actor?}` | `calendar.plan` | `201 {batch_id, ideas, dropped}` |
| POST | `/` | `{brand_profile_id, topic, angle?, pillar?, format?, hooks?, actor?}` | `calendar.plan` | `201 {idea}` |
| GET | `/:id` | | none | `{idea}` |
| PATCH | `/:id` | allowed fields + `actor?` | `calendar.plan` | `{idea}` |
| POST | `/:id/schedule` | `{date, account_id?, actor?}` | `calendar.commit` + `post.draft` | `201 {idea, post}` |
| POST | `/:id/unschedule` | `{actor?}` | `calendar.commit` | `{idea}` |

- Use `actorFromRequest(body.actor)` (`policy.ts:332`).
- **Validation** (400 with a precise message):
  - `brand_profile_id`: positive integer.
  - `count`: integer 1–12, default 8.
  - `steer`: ≤300 characters.
  - `format`: one of `feed|reel|carousel`.
  - `topic`: 1–200 characters after trimming.
  - `angle`: ≤300 characters.
  - `hooks`: ≤3 items, each ≤150 characters.
  - `chosen_hook`: ≤150 characters, or null.
  - `direction`: ≤1000 characters.
  - Unknown PATCH fields are ignored.
- **Errors:**
  - `ApiError` → `sendApiError`.
  - A generation failure that isn't an `ApiError` → `502 {error}`, mirroring `brands.ts:188-191`.
- Define `/generate` before `/:id`.

### S8 — Seed the pipeline (depends on S1, S6)

- **`server/src/skills/content-planning.ts`:**
  - Add `direction?: string | null` and `seedHook?: string | null` to `PlanContentArgs` (`:30-42`).
  - In the prompt template, right after the feedback line (`:78`), insert:
    - when `seedHook` is set: `\nOperator-chosen hook to build on (keep its idea; you may tighten the wording to meet the rules below). Use it as "hook"; alt_hooks must be different alternatives:\n"${seedHook}"\n`
    - when `direction` is set: `\nCreative direction from the operator (follow it unless it breaks the rules):\n${direction}\n`
  - When neither is set, the prompt must be byte-identical to today's.
- **`server/src/generation/pipeline.ts`:** add `direction?: string | null` and `seedHook?: string | null` to `PipelineOpts` (`:80-87`), and pass both into the `planContent({...})` call (`:169-178`). The judging code stays unchanged.
- **`server/src/agent/start-run.ts`**, pipeline branch, before `runPipeline` (`:429`): `const idea = latest.idea_id ? tryGetIdea(latest.idea_id) : null`, where `tryGetIdea` wraps `getIdea` and returns null on 404. Add `seedHook: idea?.chosen_hook ?? null, direction: idea?.direction ?? null` to the opts.
- The loop mode (`AGENT_MODE=loop`) is not seeded.

### S9 — Request changes with rerun and target (no dependencies)

In `server/src/http/routes/post-actions.ts:114-154`:
- **Body** becomes `{ author, comment, target?: 'hook'|'caption'|'visual'|'hashtags', rerun?: boolean }`. An invalid `target` → 400.
- **Insert** becomes `INSERT INTO iterations (post_id, author, comment, target) VALUES (?, ?, ?, ?)`, with `target ?? null`.
- **Rerun:** after `transitionPost`, if `body.rerun === true && next === 'changes_requested'`:
  - call `startAgentRunOnPost(post_id, { initiator: humanFromBody(author) })`, the enqueue path;
  - include `run_id` and `job_id` in the response;
  - if it throws an `ApiError` with status 409 (a run is already active), still return 200 with `rerun_error: message`. The note is saved either way.
- **Response:** `{ post, note?, run_id?, job_id?, rerun_error? }`. Omitting `rerun` and `target` gives the exact current behaviour.

### S10 — Job and run reliability (no dependencies)

- **`server/src/agent/start-run.ts`:**
  - Add `done?: Promise<void>` to `StartAgentRunResult` (`:51-56`).
  - Change `void (async () => {…})()` (`:194`) to `const done = (async () => {…})()`. The body is unchanged; it already catches and calls `completeRun`.
  - Return `{ post, run_id: run.id, note, done }`.
  - `mcp-server.ts:185` (embedded inline) ignores `done`, which is fine.
- **`server/src/jobs.ts` `handleAgentRun` (`:201-219`):**
  - Wrap the call in try/catch. On a throw, if `runId` is set, call `completeRun(runId, 'failed', msg)` (import from `./runs`), then rethrow.
  - On success, `await result.done`, then `const run = getRun(result.run_id)`, then return `{ run_id: result.run_id, run_status: run?.status ?? null, note: result.note }`.
  - Do **not** throw when the run failed: retries would re-spend tokens, and the run row is the source of truth.
- **`server/src/runs.ts` `failStaleRuns`:** add to both SELECTs (boot and age-based):
  ```sql
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = runs.id AND j.status IN ('pending','running'))
  ```
  At boot, a `running` job with an expired lease is recovered to `pending` by `recoverExpiredLeases` in `startJobWorker`, which then resumes the run.

### S11 — Client API and type fixes (depends on S2, S7, S9)

In `client/src/api.ts`:
- `estimateCost`: change the path to `'/api/budget/estimate'` (`:739-744`).
- `generateMedia`: change the return type to `{ job_id?: number; post: Post; slides?: PostSlide[]; note?: string }`.
- `requestChanges(postId, comment, opts?: { target?: 'hook'|'caption'|'visual'|'hashtags'; rerun?: boolean })`: send `{ author: DEV_OPERATOR, comment, ...opts }`, returning `PostResponse & { note?: string; run_id?: number; job_id?: number; rerun_error?: string }`.
- New functions, each sending `actor: DEV_OPERATOR` in mutating bodies:
  - `listIdeas(brandId, status?)`
  - `getIdea(id)`
  - `generateIdeas(brandId, { count?, steer?, pillar?, format?, like_idea_id? })`
  - `createIdea(brandId, { topic, angle?, pillar?, format?, hooks? })`
  - `updateIdea(id, patch)`
  - `scheduleIdea(id, { date, account_id? })`
  - `unscheduleIdea(id)`
- Re-export `Idea` and `IdeaStatus`.

### S12 — Shared week helpers (no dependencies)

- Move `mondayOf`, `isoDay`, `addDays` and `weekLabel` verbatim from `client/src/routes/CalendarScreen.tsx:19-41` into `client/src/lib/week.ts`, and import them in CalendarScreen.
- Fix `SetupScreen.weekStartISO` drift by not using it (S17 removes the call).

### S13 — Next-step resolver (depends on S2)

Rewrite `client/src/lib/post-studio-actions.ts`. **First complete S18**, deleting the dead `PostStudio.tsx`, its only importer. If S18 is not approved, keep `resolveStudioPrimary` exported unchanged and add the new function alongside it.

- Keep `carouselApproveBlocked` and `carouselMediaBlocked`.
- Add `export type NextActionKind = 'write_draft'|'rewrite_draft'|'restart_draft'|'approve_copy'|'revise_with_notes'|'try_hooks'|'generate_visual'|'regenerate_visual'|'open_studio'|'approve_visual'`.
- Add `export type NextAction = { kind; label; disabled: boolean; title?: string }`.
- Add `export type NextStep = { stage: 'idea'|'copy'|'visuals'|'ready'|'live'|'failed'; primary: NextAction|null; secondary: NextAction[]; info?: string }`.
- Add `export function resolveNextStep(post: Post, slides: PostSlide[]): NextStep`. Rules:

| Status | Stage | Primary | Secondary | Info |
|---|---|---|---|---|
| `draft`, hook empty | `idea` | `write_draft` "Write draft" | — | |
| `draft`, hook present | `copy` | `rewrite_draft` "Rewrite draft" | — | |
| `changes_requested` | `copy` | `rewrite_draft` "Rewrite with notes" | — | |
| `needs_revision` | `copy` | — | `restart_draft` "Restart to draft" | "Revision limit reached" |
| `pending_approval` | `copy` | `approve_copy` "Approve copy"; disabled if `carouselApproveBlocked`, title "Carousel needs ≥2 slides with copy" | `revise_with_notes` "Revise with notes", `try_hooks` "Try new hooks" | |
| `approved` | `visuals` | `generate_visual` "Generate visual" | `open_studio` "Design in Studio" | |
| `media_generating` | `visuals` | — | — | "Generating visual…" |
| `media_ready` | `visuals` | `approve_visual` "Approve visuals"; disabled if `carouselMediaBlocked` | `regenerate_visual` "Regenerate visual", `open_studio` | |
| `staged`, `pending_upload`, `publishing` | `ready` | — | — | "Scheduled" |
| `published` | `live` | — | — | |
| `failed` | `failed` | — | — | `post.error ?? 'Failed'` |

### S14 — Polling hook (no dependencies)

Create `client/src/lib/use-poll.ts` exporting `usePoll<T>(fn: (() => Promise<T>) | null, isDone: (v: T) => boolean, onDone: (v: T) => void, intervalMs = 1500): { value: T | null }`.
- It runs `fn` on an interval while `fn` is non-null and stops when `isDone` returns true, calling `onDone` once.
- It clears the interval on unmount or when `fn` changes.
- No react-query, so it is usable in PostScreen.

### S15 — PostScreen craft workspace (depends on S11, S13, S14)

Edit `client/src/routes/PostScreen.tsx`, keeping `useState` / `reload()`.
**Do not remove** the Phase 4 `performance` tab or its panel.

1. **Idea loading.** In `reload` (`:385+`), when `post.idea_id` is set, also fetch
   `getIdea(post.idea_id)` into `idea` state. A 404 means `idea = null`.
2. **`IdeaPanel`** (new, in the same file), rendered above the tabs when `idea` is set:
   - Shows the angle and the "why".
   - Hook sketches are radio buttons, plus a "Let the writer choose" option meaning `chosen_hook=null`. Changing one calls `updateIdea(idea.id, {chosen_hook})`.
   - A "Direction for the writer" textarea saves on blur via `updateIdea(id, {direction})`, with a toast on error.
   - Inputs are disabled unless `post.status` is `draft` or `changes_requested`.
3. **Action bar** (`:841+`) is driven by `resolveNextStep(post, slides)`. Keep `data-testid`
   `approve-copy` (approve_copy) and `approve-media` (approve_visual). Add these testids and handlers:

| Testid | Calls | Then |
|---|---|---|
| `write-draft` / `rewrite-draft` | `agentRun(id)` | set `activeRunId = res.run_id` |
| `revise-with-notes` | opens `RequestChangesModal` | |
| `try-hooks` | `studioAction(id, 'alternate-hooks')` | merge the returned `hooks` into a local `extraAlternates` list shown by `HookAlternates` (swap still uses `patchPost`) |
| `generate-visual` / `regenerate-visual` | `generateMedia(id)` | set `activeJobId = res.job_id`; if there's no `job_id`, `reload()` |
| `open-studio` | `navigate({ to: '/studio/$postId', params: { postId: String(id) } })` | |
| `restart-draft` | `restartPost(id, { clear: false })` | `reload()` |

   - Show the cost in labels for write and generate visual. Fetch once per mount with `estimateCost({kind:'agent_run'})` and `estimateCost({kind: post.format === 'reel' ? 'generate_reel' : 'generate_image'})`. On failure, show no cost.
4. **RequestChangesModal** gets `onSubmit(comment, target)`. Stop prefixing `[Target]` into the comment text. `handleRequestChanges` calls `requestChanges(id, comment, { target, rerun: true })`.
   - If `run_id` comes back, set `activeRunId`.
   - If `note` or `rerun_error` comes back, show them with `toast.message`.
5. **Progress strip.**
   - **Runs:** while `activeRunId` is set, `usePoll(() => getRun(activeRunId), d => d.run.status !== 'running', d => { setActiveRunId(null); toast[...]; void reload() })`. Render a strip under the header (`data-testid="run-progress"`) showing `Writing… · <last step>` from the latest `step` event's `payload.step`.
   - **Jobs:** the same pattern for `activeJobId`, done when `job.status` is `done` or `failed` (`data-testid="job-progress"`, "Generating visual…").
   - **On mount:** if `reload()` finds a `pending`/`running` job, resume polling. Use `agent_run`'s `run_id` or `generate_media`'s `id` from the `listJobs` result.
   - Disable all actions while either poll is active.
6. **Stepper.** Map `changes_requested` and `needs_revision` to the `pending_approval` step index (1) instead of 0 (`:45-46`). Show `resolveNextStep(...).info` next to the status pill.

### S16 — Plan screen (depends on S11, S12, S13)

- **Routing:** create `client/src/routes/PlanScreen.tsx` (`export function PlanScreen`). Register a lazy route `/plan` in `client/src/router.ts` (pattern `:10-24,52-56`, add to `routeTree`). Add `{ label: 'Plan', to: '/plan', icon: Lightbulb }` to `Shell.tsx` `NAV_ITEMS` between Inbox and Calendar, and import `Lightbulb` from lucide-react.
- **State** (mirrors CalendarScreen):
  - brand: `brandId ?? brands[0]?.id`, with a `<select>`
  - `accountId`
  - `weekStart = mondayOf(new Date())`, with prev / today / next
  - `tab: 'board'|'shortlist'|'dismissed'`
  - `steer`, `pillar`, `format`, `count = 8`
- **Queries:**
  - `['brands']` → `listBrandProfiles`
  - `['ideas', brandId, tab]` → `listIdeas(brandId, tab === 'board' ? 'board' : tab === 'shortlist' ? 'shortlisted' : 'dismissed')`
  - `['calendar', from, to, brandId, accountId]` → `listCalendar`
  - `['estimate','ideas']` → `estimateCost({kind:'ideas'})`, falling back to the server's 0.01 default. **Do not** invent a server kind.
  - Invalidate `['ideas']`, `['calendar']` and `['posts']` after mutations.
- **Layout, top: cadence line only** (no week strip / day columns — see `plan-surface-riff`). Shows `N of posts_per_week this week` from current-week `listCalendar`, plus a Calendar link. Week grid and Unschedule live on Calendar.
- **Layout, main: idea board.**
  - Header: title `Plan`, brand select, account select when needed, Calendar chrome link.
  - Compose: steer input (`placeholder="Ideas about…"`), pillar, format, count (4/8/12), "Generate ideas · ~$X" (`data-testid="generate-ideas"`), "My own idea".
  - Tabs: Inbox-style underline Board / Shortlist / Dismissed with counts.
  - Ideas grouped by `batch_id`.
- **IdeaCard** (`data-testid="idea-card"`):
  - Content: topic, angle, pillar/format chips, hooks, why; optional `Riff of {parent}` cue.
  - Actions (L→R): Shortlist Star (`data-testid="shortlist-idea"`) · Add to day (`data-testid="schedule-idea-select"`, current week) · Riff (pending → `Riffing…`) · Dismiss.
  - Scheduled ideas don't appear on the board (server `'board'` filter).
- **Empty states:**
  - No brand: "Create a brand first" with a link to Settings/Setup.
  - No ideas: one sentence plus a Generate button.
  - Loading: `animate-pulse` blocks, as in CalendarScreen `:612`.
- **Errors:** toast with the server message (409 unschedule text shown verbatim).

### S17 — Calendar, Setup and Home entry points (depends on S12, S13, S16)

- **`CalendarScreen.tsx`:**
  - Delete the `proposals` / `estimate` state, `handleFillWeek`, `handleCommit`, `updateProposal`, `dropProposal`, `GhostCard`, the proposals panel (`:645-717`) and the two header buttons (`:542-569`).
  - Add a "Plan this week" button that does `navigate({ to: '/plan' })`.
  - In `PostCard`, add a muted next-step label from `resolveNextStep(post, []).primary?.label ?? info`.
  - Remove the now-unused `fillWeek`, `estimateCost` and `CalendarProposal` imports.
- **`SetupScreen.tsx` `StepFirstWeek`:** replace `generate()` with `navigate({ to: '/plan' })`. Button text: "Plan your first week". Description when not done: "Shortlist ideas and place them on days." Remove the `fillWeek` import if unused.
- **`HomeScreen.tsx`** "Plan more posts" link (`:458-463`): change `to` to `/plan`.

### S18 — Remove dead screens (needs separate approval; see §7)

Before deleting, confirm the working tree is committed or stashed (`git status`). `PostStudio.tsx` is untracked, so deleting it is unrecoverable otherwise.
- `grep -rn "Dashboard\|PostStudio\|CalendarWeek" client/src` must show only the files themselves.
- Delete `client/src/components/Dashboard.tsx`, `PostStudio.tsx` and `CalendarWeek.tsx`.
- Leave `PostDialog.tsx`, `layout.tsx` and `ui/dialog.tsx` for a later cleanup (out of scope).

## 6. Business rules and edge cases

**Idea generation**
- `count` outside 1–12 → 400. Riff always generates 3.
- If every generated idea is a repeat, return `201` with `ideas: []` and `dropped: N`. The UI says "All ideas repeated past content — try a different steer".
- The LLM fails or times out → 502 with the message. Nothing is stored. Spend is whatever the adapter logged.
- When the reel budget is exhausted, no reel ideas are produced (they are mapped to feed).
- `like_idea_id` belonging to another brand → 400. An unknown id → 404.

**Curation**
- A dismissed idea is excluded from the board but stays in the dedupe avoid list. Only non-dismissed ideas are in the avoid list, so dismissing makes a topic reusable on purpose.
- You can't PATCH `status` to `scheduled`; only the schedule route can.

**Scheduling**
- Only `new` or `shortlisted` ideas can be scheduled; a `scheduled` or `dismissed` idea → 409.
- Several ideas on the same day are allowed (no slot limit). The balance line shows over-planning ("5 of 4 planned").
- `scheduled_at` = date + `T12:00:00.000Z` (existing `createDraftFromProposal` rule, `brand.ts:425-427`).
- Example: scheduling idea 12 ("Morning prayer routine", carousel) on `2026-11-12` creates post 87 (`draft`, `format='carousel'`, `scheduled_at='2026-11-12T12:00:00.000Z'`, `idea_id=12`, placeholder slides from `ensureSlidesForFormat`). Idea 12 becomes `status='scheduled', post_id=87`.

**Unscheduling**
- **Untouched** = `draft` and `hook`/`caption` NULL, with no runs and no iterations.
  - Dragging the post to another day only changes `scheduled_at`, so it is still untouched.
  - After "Write draft" (a run exists), unscheduling → 409.
- If the linked post was already deleted (e.g. via `DELETE /api/posts/:id`), unscheduling just resets the idea to `shortlisted`.

**Seeding**
- When `chosen_hook` is null, the writer chooses freely. `direction` empty or null → no prompt change.
- Edits to the idea take effect on the next run. A run already in flight uses the values read at its start.
- A post without `idea_id` (created via Studio, Fill week or MCP) runs exactly as today.

**Revise with notes**
- Only from `pending_approval` (existing transition rule; other states → 409 from `transitionPost`).
- At the 3rd revision the post becomes `needs_revision` and no run starts. The response note explains this, and the UI shows "Restart to draft".
- If a run is already active, the note is still saved and `rerun_error` is shown.

**Permissions**
- All idea mutations require a human actor with an id (`policy.ts:142-159`). The client always sends `DEV_OPERATOR`; missing → `DASHBOARD_OPERATOR`.
- An `operator_agent` or agent actor → 403 via `assertAllowed`, which records a policy-deny run.
- Ideas are always scoped by `brand_profile_id`. Cross-brand riff → 400.

**Concurrency**
- After S10, `agent_run` jobs run one at a time. Other job kinds (e.g. `publish_post`) wait behind a running agent job (~1–2 min). This is accepted because the scheduler retries every 15s.
- The lease is renewed every 10s by `runJob`.
- `scheduleIdea` uses `BEGIN IMMEDIATE` so a double click can't create two posts: the second call sees `status='scheduled'` → 409.

**Polling**
- 1.5s interval, stopped on unmount.
- If the run ends `failed`, toast `run.error` and reload; the post stays `draft` and "Write draft" is available again.
- If the job ends `failed`, toast `job.error`. A `needs_budget_approval` error shows "Over budget — raise the cap in Settings".

**Cost labels**
- Fetched with `/api/budget/estimate`. On failure, labels show no price. They never block an action.

## 7. Constraints and compatibility

**Must not change**
- `POST /api/brand-profiles/:id/fill-week` and `fillWeekForBrand`.
- MCP `fill_week`, `start_run_on_post` and `run_content_pipeline`.
- `POST /api/posts/:id/agent-run`.
- The `request-changes` behaviour when `rerun`/`target` are omitted.
- The approve and approve-media routes.
- `VALID_TRANSITIONS`.
- The `generateObject` signature and judge/hook-pick logic in `pipeline.ts`.

**Keep passing**
- Server: all `phase4-*` suites, `jobs`, `restart-archive`, `phase2-hitl-routes`, `evals/checks`.
- Client: `PostScreen.test.tsx` (media_ready approve-media **and** Performance tab),
  `StudioScreen*.test.tsx`, `InsightsScreen.test.tsx`, `SetupScreen.reconnect.test.tsx`.

**Conventions**
- Migrations are numbered SQL files.
- Routes use `sendApiError`/`ApiError` and `actorFromRequest` + `assertAllowed`.
- Server tests use a temp `DB_PATH` with dynamic imports and an `express().listen(0)` + `fetch` harness.
- LLM mocks go through `vi.mock('../skills/model')`.
- Client data screens use react-query, except PostScreen.

**Do not**
- add a charting, Radix or DnD library;
- migrate PostScreen to react-query;
- change `HookPickSchema`.

**Needs separate approval**
- S18 (deleting `Dashboard.tsx`, `PostStudio.tsx` and `CalendarWeek.tsx`). Commit or stash the 118-file working tree first.

**Out of scope**
- MCP idea tools (Phase 5).
- Batch "write all".
- Seeding the legacy loop mode.
- Fixing the adapter writing `spend_ledger` rows with `estimated=1`, which `monthlySpend` ignores (see §11).

## 8. Requirement-to-implementation mapping

| Req | Implementation | Verification |
|---|---|---|
| F1 Generate ideas | S1, S2, S5, S6 `generateIdeaBatch`, S7 `POST /generate`, S16 board | ideas-service: batch stored, `batch_id` shared, steer saved. ideas-routes: 201. PlanScreen test: Generate calls `generateIdeas` |
| F2 Riff | S5 `likeIdea`, S6, S16 Riff button | ideas-service: riff → 3 rows, `source='riff'`, `parent_idea_id`. Cross-brand → 400 |
| F3 Manual idea | S6 `createManualIdea`, S7 `POST /`, S16 form | ideas-routes: 201 shortlisted; empty topic → 400 |
| F4 Curate | S6 `updateIdea`, S7 PATCH, S16 tabs and buttons | ideas-routes: status change, `board` filter. PlanScreen test: ☆ calls `updateIdea(...shortlisted)` |
| F5 No repeats | S3, S6 dedupe | similarity tests. ideas-service: duplicate of a recent hook or existing idea dropped, `dropped` count |
| F6 Cadence (board-only) | S16; refined in `plan-surface-riff` | Plan shows cadence line only; no day grid. Calendar owns week UI |
| F7 Schedule | S6 `scheduleIdea`, S7, S16 select | ideas-service: post fields + `idea_id` + idea scheduled; double schedule → 409. PlanScreen: Add to day calls `scheduleIdea` |
| F8 Unschedule | S6 `unscheduleIdea`, S7, S16 | ideas-service: untouched → deleted + shortlisted; with run or hook → 409 |
| F9 Idea panel | S11 `getIdea`/`updateIdea`, S15.1–2 | PostScreen test: hook radio calls `updateIdea({chosen_hook})` |
| F10 Write draft | S8, S10, S13, S14, S15.3/5 | start-run seed test. PostScreen test: `write-draft` calls `agentRun`, shows `run-progress` |
| F11 Revise | S9, S11, S15.4 | request-changes-rerun test. PostScreen test: submit calls `requestChanges(9, …, {target, rerun:true})` |
| F12 Try hooks | S15.3 | PostScreen test: `try-hooks` calls `studioAction(9,'alternate-hooks')`, renders the new alternate |
| F13 Visuals | S11, S13, S15.3/5 | PostScreen test: approved → `generate-visual` calls `generateMedia`; `open-studio` navigates. Existing approve-media test still passes |
| F14 Calendar | S17 | Manual; typecheck (no fillWeek import). Resolver unit test drives labels |
| F15 Setup | S17 | SetupScreen test: button navigates to `/plan` |
| F16 Nav/Home | S16, S17 | Manual; route renders |
| T1 Job awaits | S10 | agent-run-job test: job `done` only after the pipeline resolves; a throw closes the run as failed |
| T2 Sweeper | S10 | agent-run-job test: `failStaleRuns(0)` and the aged sweep skip runs with pending jobs |
| T3 estimate path | S11 | Typecheck. PostScreen/PlanScreen mocks expect the call. Manual: cost labels show |
| T4 generateMedia type | S11 | Typecheck (`res.job_id` used in S15) |
| T5 Shared helper | S3 | `evals/checks.test.ts` and the new similarity test pass |
| T6 Compatibility | §7 | Existing suites pass. request-changes without `rerun` enqueues nothing |

## 9. Acceptance criteria

1. On `/plan`, choosing a brand and clicking **Generate ideas** with the steer "winter routines" adds a batch labelled "winter routines" of up to 8 cards. Each card has a topic, angle, pillar, format, 2–3 hooks and a why. No card's topic or hook is a >0.6 trigram match of an earlier idea or a recent published hook.
2. **Riff** on a card adds 3 cards linked to it.
3. **☆** moves a card into the Shortlist tab. **✕** moves it to Dismissed, and Restore brings it back.
4. Choosing Wednesday in **Add to day…**:
   - creates a `draft` post on that date with the idea's topic, angle, pillar and format, and `idea_id` set;
   - the card leaves the board;
   - Calendar's Wednesday column shows the post;
   - no `spend_ledger` row is written.
5. **Unschedule** on Calendar (untouched post) deletes it and returns the idea to the Shortlist. After "Write draft" has run, Unschedule shows "This post is already being crafted — open it instead".
6. On `/posts/:id` for that draft:
   - the Idea panel shows the hooks;
   - choosing hook #2 and writing a direction persists both (reload shows them);
   - **Write draft** shows the progress strip, and when the run succeeds the post shows the new hook/caption with status Needs OK;
   - the plan prompt contained the chosen hook and the direction (verified by test).
7. **Revise with notes** (target Caption, "shorter, warmer") records an iteration with `target='caption'` and starts a new run without another click. The third revision shows "Revision limit reached" with **Restart to draft**.
8. **Approve copy** → **Generate visual** shows "Generating visual…" until the job finishes, then shows **Approve visuals**. **Design in Studio** opens `/studio/<id>` with that post. **Approve visuals** moves the post to Scheduled.
9. The Calendar has **Plan this week** (no Fill week). Its cards show next-step labels. Setup's last step navigates to `/plan`.
10. While an `agent_run` job is executing, `GET /api/jobs/:id` shows `running` until the run finishes. Two "Write draft" clicks on different posts execute one after the other. A queued run older than 10 minutes is not marked failed while its job is still pending.
11. `pnpm --filter shared build && pnpm typecheck` passes with 0 errors, and `pnpm test` passes on server and client.

## 10. Testing strategy

### Server (vitest)

All new test files follow `phase4-insights-routes.test.ts`: temp `DB_PATH` at the top level, dynamic imports in `beforeAll`, `express().listen(0)` + `fetch`, and LLM calls mocked with `vi.mock('../skills/model', () => ({ createStructuredModel: () => ({ invoke }) }))`, where `invoke` returns per-test data.

- **`src/__tests__/similarity.test.ts`:**
  - identical strings → true;
  - "5 morning habits for calm" vs "Five morning habits for calm" → true;
  - unrelated strings → false;
  - empty strings → false (jaccard 0).
- **`src/__tests__/ideas-service.test.ts`:**
  - Seed a brand and a non-draft post with hook "Stop scrolling: your morning prayer matters".
  - `generateIdeaBatch` with `invoke` returning 5 ideas, including one whose hook duplicates the seeded hook and one duplicating an existing idea topic → 3 stored, `dropped: 2`, shared `batch_id`, `source='ai'`, `steer` saved.
  - Riff: `like_idea_id` → rows `source='riff'`, `parent_idea_id` set. Another brand's idea → 400.
  - Budget at cap (insert a `spend_ledger` row with `estimated=0` and `cost_usd` ≥ cap) → a returned `reel` idea is stored as `feed`.
  - `scheduleIdea` → post `draft` with topic, angle, pillar, format, `scheduled_at` `…T12:00:00.000Z` and `idea_id`; idea `scheduled` + `post_id`. Second schedule → 409. Bad date `2026-13-40` → 400.
  - `unscheduleIdea`: untouched → post row gone, idea `shortlisted`, `post_id` null. After `UPDATE posts SET hook='x'` → 409. After inserting a `runs` row → 409.
  - `updateIdea` on a scheduled idea: `topic` → 409; `direction` → ok. `status: 'scheduled'` → 400.
- **`src/__tests__/ideas-routes.test.ts`:**
  - Mount `ideasRouter` at `/api/ideas`.
  - `GET ?status=board` excludes dismissed and scheduled.
  - `POST /generate` → 201 shape.
  - `POST /` with empty topic → 400. `PATCH` with unknown fields ignored.
  - Actor `{id:'a', role:'operator_agent'}` on `/:id/schedule` → 403. Unknown id → 404.
- **`src/__tests__/content-planning-seed.test.ts`:**
  - Mock `../skills/model` capturing the `invoke` prompt.
  - `planContent({topic, seedHook:'X hook', direction:'be playful'})` → the prompt contains both strings.
  - Without them, the prompt contains neither "Operator-chosen hook" nor "Creative direction".
- **`src/__tests__/agent-run-seed-and-job.test.ts`:**
  - `vi.mock('../generation/pipeline', …)` with a `runPipeline` mock that records its opts and resolves after a deferred promise (you may make it reject, so the run fails cleanly in the existing catch).
  - Seed: an idea with `chosen_hook` and `direction`, a post with `idea_id`. `startAgentRunOnPost(id,{inline:true})`, then `await result.done` → `runPipeline` got `seedHook` and `direction`.
  - Job awaits: enqueue via `startAgentRunOnPost(id)`, `claimJob()`, start `runJob(job)` without awaiting → the job status is still `running` while the deferred is unresolved; resolve it → after `await`, the job is `done` and the run is not `running`.
  - Throw path: set the post to `pending_approval` before `runJob` → the job fails or retries and the pre-created run is `failed`.
  - Sweeper: a run `running` with a pending job and `started_at` 20 minutes ago → `failStaleRuns(600000)` and `failStaleRuns(0)` leave it running. A run without a job → failed.
- **`src/__tests__/request-changes-rerun.test.ts`:**
  - Mount `postActionsRouter`; post in `pending_approval`.
  - `{author, comment, target:'caption', rerun:true}` → 200, `run_id` and `job_id` present, a `jobs` row `kind='agent_run'`, an `iterations.target='caption'` row.
  - Without `rerun` → no job (compatibility).
  - Invalid target → 400.
  - At revision cap → `needs_revision`, no job, note present.
- **Regression:** the whole existing suite (`pnpm --filter server test`), including `evals/checks.test.ts` after S3.

### Client (vitest + RTL)

- **`src/lib/post-studio-actions.test.ts`:** a table test of `resolveNextStep` for every status row in S13, including the carousel-blocked disabled cases.
- **Update `src/routes/PostScreen.test.tsx`:**
  - Add mocks for `agentRun`, `getIdea`, `updateIdea`, `studioAction`, `generateMedia`, `getRun`, `getJob`, `estimateCost`, `restartPost` and `requestChanges`. Keep the router mock and add `useNavigate` returning `navigateMock`.
  - New tests:
    - (a) empty draft → `write-draft` visible; click calls `agentRun(9)`; `run-progress` appears (`getRun` resolves `running`).
    - (b) draft with `idea_id` → Idea panel; choosing a hook calls `updateIdea(…, {chosen_hook})`.
    - (c) `pending_approval` → `revise-with-notes` opens the modal; submit calls `requestChanges(9, comment, {target:'caption', rerun:true})`.
    - (d) `try-hooks` calls `studioAction(9,'alternate-hooks')` and renders a returned hook.
    - (e) `approved` → `generate-visual` calls `generateMedia(9)`; `open-studio` calls `navigateMock` with `/studio/$postId`.
  - The existing media_ready and Performance tests are unchanged and still pass.
- **New `src/routes/PlanScreen.test.tsx`:**
  - `vi.hoisted` mocks for `listBrandProfiles`, `listIdeas`, `generateIdeas`, `createIdea`, `updateIdea`, `scheduleIdea`, `unscheduleIdea`, `listCalendar` and `estimateCost`; `QueryClientProvider` wrapper; router mock (`useNavigate`).
  - Tests: renders 7 day columns; Generate with steer "winter" calls `generateIdeas(1, {steer:'winter', count:8})`; ☆ calls `updateIdea(5,{status:'shortlisted'})`; the "Add to day" select calls `scheduleIdea(5,{date: <wed iso>})`; a 409 on Unschedule shows the server message (toast mock).
- **Update `src/routes/SetupScreen.reconnect.test.tsx`** (or add `SetupScreen.firstweek.test.tsx`): "Plan your first week" calls `navigate({to:'/plan'})`.

### Typecheck and manual

- `pnpm --filter shared build`, then `pnpm typecheck` (shared, server, server evals, client).
- Manual end to end with `pnpm dev` (criteria 1–10), plus a check that the Calendar shows no Fill week button and cost labels show prices (T3).

## 11. Risks and unresolved questions

- **`resolveBrandContextV2` needs a Post.** S4 builds a synthetic Post. Verified reads:
  `brand_profile_id`, `brand_overrides`, `background_style`, `format`, plus
  `loadPerformanceSummary(brand_profile_id)`. Re-read the function before writing S4; add any
  newly dereferenced fields as null.
- **`post.draft` resource type — resolved.** Policy requires `{type:'post', post}`. S6 must
  assert after `createDraftFromProposal` inside `BEGIN IMMEDIATE` and roll back on deny
  (same as `fill-week.ts:111-113`). Do not try brand-scoped `post.draft`.
- **Serialising agent runs (S10)** makes other job kinds wait during a run (~1–2 min). Acceptable
  for a single operator; revisit if publishes slip.
- **Text spend not counted toward the cap.** Adapter writes `spend_ledger` with `estimated=1`,
  which `monthlySpend` ignores — idea-generation spend won't move the meter. Existing issue;
  out of scope; track in `docs/phase-tracker.md`.
- **`maxOutputTokens` isn't enforced** by the adapter (cost estimate only). Prefer schema
  `.max(20)` + truncate to `count` in code if zod rejects oversized LLM batches.
- **Dirty working tree.** ~118 uncommitted paths. Re-verify line numbers before each step;
  `git status` / stash-or-commit before S18 deletes.
- **Inbox doesn't list drafts.** Crafting starts from Plan or Calendar. Inbox "Crafting" stage
  is a follow-up, not in scope.
- **Phase tracker drift.** `docs/phase-tracker.md` still marks Phase 4 "not started" — update
  that tracker in a separate docs pass; do not block this feature on it.
