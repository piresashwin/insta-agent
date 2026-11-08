# Plan surface + idempotent riff: implementation plan

Status: ready for implementation. Produced via `/feature-planning` on **2026-11-08**.
Verified against `/Users/ashwin/dev/instagram-agent` (PlanScreen, ideas service/routes, DESIGN.md).

**Parent feature.** Builds on Idea → Post ([`docs/features/idea-to-post-flow/IMPLEMENTATION.md`](../idea-to-post-flow/IMPLEMENTATION.md)). That flow shipped Explore → Shortlist → Craft; this change refines Plan UX and riff concurrency. It is **not** S18 dead-screen deletion, PostScreen craft work, or Calendar redesign.

**Locked decisions (operator)**

| # | Choice | Meaning |
|---|--------|---------|
| 1 | **C** | Riff idempotency = coalesce in-flight / double-submit only. A deliberate second click *after* completion still generates a new set of 3. |
| 2 | **A** | Remove the week grid from Plan; keep compact **Add to day…** on each idea card. Calendar remains the week editor. |

---

## 1. Feature overview

**The problem.** Plan currently mixes two jobs:

1. **Explore / curate ideas** (generate, riff, shortlist, dismiss).
2. **Week placement** (7-day strip, prev/today/next, drag-drop onto days, Craft/Unschedule on day cells).

That duplicates Calendar ([`client/src/routes/CalendarScreen.tsx`](../../../client/src/routes/CalendarScreen.tsx)), confuses the operator, and burns LLM spend when **Riff** is double-clicked: [`IdeaCard`](../../../client/src/routes/PlanScreen.tsx) calls `generateIdeas(..., { like_idea_id })` with no pending guard, and [`generateIdeaBatch`](../../../server/src/services/ideas.ts) always inserts a new batch.

**What the operator wants**

- Plan = idea board only (explore → curate → light handoff via Add to day).
- Calendar = place and craft cadence.
- Riff = safe under mashed clicks / overlapping HTTP, but still able to generate fresh variations later.

**What gets built**

- Process-local in-flight coalesce for riff (`like_idea_id`) on the server.
- Per-idea Riff pending lock on the client.
- PlanScreen stripped of week grid/nav/DnD; header + cadence line + compose + tabs + cards redesigned to DESIGN.md Operate language.
- Doc update to Idea → Post F6.

---

## 2. Requirements

### Functional

- **F1 — Riff in-flight coalesce.** While a riff for `(brand_profile_id, like_idea_id)` is running, a second `POST /api/ideas/generate` with the same pair must not start a second LLM call. It awaits the first work and returns the **same** `{ batch_id, ideas, dropped }` body (HTTP 201). After the first settles, a later request generates a **new** batch (new `batch_id`, new rows, `source='riff'`, same `parent_idea_id`).
- **F2 — Client Riff pending.** While a riff for idea `id` is in flight, that card’s Riff control is disabled, shows `Riffing…`, and sets `aria-busy`. Extra clicks are ignored. Other cards’ Riff remain usable. Full-batch **Generate ideas** pending does not need to block Riff on other ideas (and vice versa), but Generate stays disabled while its own mutation is pending.
- **F3 — Plan is board-only.** Plan must not show: week Prev/Today/Next, 7-day grid, drag-drop onto days, or day-cell Craft/Unschedule. `data-testid="plan-day"` is removed (no replacements).
- **F4 — Add to day retained.** Each non-dismissed idea card keeps `data-testid="schedule-idea-select"` listing the **current calendar week** (Monday–Sunday of “today”, via [`mondayOf` / `addDays` / `isoDay`](../../../client/src/lib/week.ts)). Selecting a day calls existing `scheduleIdea` with optional `account_id`. Unschedule stays on Calendar / Post craft — not on Plan day cells (those cells are gone).
- **F5 — Calendar escape hatch.** Header includes a chrome **Calendar** link to `/calendar`.
- **F6 — Cadence line.** One muted text line under the header: `{n} of {posts_per_week} this week` from a single current-week `listCalendar` fetch, plus the same Calendar affordance context. No day cells, no format/pillar breakdown grid. If `posts_per_week` is null, show `{n} planned this week`.
- **F7 — Plan chrome hierarchy.** Header: title `Plan` · brand `<select>` · account `<select>` when `connections.length > 1` · Calendar link. No week label as the primary title.
- **F8 — Compose bar.** Steer, pillar, format, count, **Generate ideas** (accent, cost suffix), **My own idea**. Sticky/`--surface` strip with `--rule` divider; native fields with `--control` outlines (match Calendar/Inbox).
- **F9 — Tabs.** Inbox-style underline tabs: Board · Shortlist · Dismissed with count badges (existing query keys). Accent underline + accent count when active.
- **F10 — Card hierarchy.** Topic + format glyph; angle; raised chips (no second border); hooks; faint why. Actions L→R: Shortlist (Star) · Add to day… · Riff · Dismiss (X). Riff is muted/text weight, not accent-filled. Design: one surface tone **or** border — cards use border + `--surface` like Calendar post cards (established peer), chips use `--raised` fill only.
- **F11 — Riff parent cue.** When `idea.source === 'riff'` and `parent_idea_id` resolves to a topic in the currently loaded ideas for that brand tab (or a small `Map` built from the active list + board count queries if already fetched), show muted `Riff of {parent topic}` truncated. If parent topic is not in memory, omit the cue (no extra `getIdea` round-trip in v1).
- **F12 — Empty / loading.** Loading: `--raised` pulse skeleton. Empty copy per tab teaches the next action (Board → generate; Shortlist → star; Dismissed → none).

### Technical

- **T1.** Coalesce map is process-local in [`server/src/services/ideas.ts`](../../../server/src/services/ideas.ts) (no Redis). Key: `` `${brandProfileId}:${likeIdeaId}` ``. Clear in `finally` after settle (success or failure). Failed first attempt must clear the key so retry works.
- **T2.** API contract of `POST /api/ideas/generate` unchanged ([`server/src/http/routes/ideas.ts`](../../../server/src/http/routes/ideas.ts)). No new endpoints, no schema migration.
- **T3.** Non-riff generate (no `like_idea_id`) is **not** coalesced across requests.
- **T4.** Design tokens from [`DESIGN.md`](../../../DESIGN.md) / `client` `:root` — no new accent family, no emoji, lucide 16px / 1.5 stroke.
- **T5.** Update Idea → Post doc F6 to state Plan is board-only; week grid lives on Calendar; Add to day remains on cards.

### Out of scope

- S18 delete of `Dashboard` / `PostStudio` / `CalendarWeek`.
- Changing riff count (stays 3), dedupe rules, or idea-generation prompt/schema (except as needed if tests mock them).
- Returning cached historical riffs on every click (that was option A — rejected).
- Replacing old riff children on regenerate (option B — rejected).
- CalendarScreen layout redesign.
- Unschedule / Craft from Plan.
- Multi-process coalesce (single Node server assumed).

---

## 3. Existing implementation analysis

### Verified

| Area | Location | Notes |
|------|----------|-------|
| Plan screen | `client/src/routes/PlanScreen.tsx` | Week header, cadence, 7-day strip (`plan-day`), compose, tabs, `IdeaCard` with Star/X/Riff/Add to day |
| Week helpers | `client/src/lib/week.ts` | `mondayOf`, `isoDay`, `addDays`, `weekLabel` |
| Client API | `client/src/api.ts` | `listIdeas`, `generateIdeas`, `scheduleIdea`, `listCalendar`, `estimateCost` |
| Ideas service | `server/src/services/ideas.ts` | `generateIdeaBatch`, `scheduleIdea`, `listIdeas`, riff sets `count=3`, `source='riff'`, `parent_idea_id` |
| Ideas routes | `server/src/http/routes/ideas.ts` | `POST /generate` → `generateIdeaBatch` |
| Idea type | `shared/src/index.ts` | `Idea.source`, `parent_idea_id` |
| Ideas route tests | `server/src/__tests__/ideas-routes.test.ts` | Mocks `createStructuredModel`; covers board + generate |
| Calendar peer UX | `client/src/routes/CalendarScreen.tsx` | Header strip, `--control` selects, accent primary CTA |
| Inbox tabs peer | `client/src/routes/InboxScreen.tsx` | Underline tabs + count badges |
| Design system | `DESIGN.md` | accent-ladder light, raspberry `#b8336a` |
| In-flight coalesce precedent | — | **None** in `server/src` (grep empty). Introduce in ideas service. |

### Current riff path (broken for double-submit)

```
IdeaCard onClick
  → generateIdeas(brandId, { like_idea_id })   // no pending lock
  → POST /api/ideas/generate
  → generateIdeaBatch(..., { likeIdeaId })
  → generateIdeas skill (LLM) + INSERT rows
```

### Current Plan calendar coupling to remove

- State: `weekStart`, `from`/`to`, `byDay`, `formatCounts`/`pillarCounts` for grid.
- UI: week nav buttons, `plan-day` columns, DnD `onDrop` → `scheduleIdea`.
- Keep: `listCalendar` **only** for F6 cadence count (`posts.length`), or simplify to that single use.

---

## 4. Proposed technical approach

### 4.1 Server riff coalesce

In `server/src/services/ideas.ts`, module scope:

```ts
type BatchResult = { batch_id: string; ideas: Idea[]; dropped: number }
const riffInflight = new Map<string, Promise<BatchResult>>()
```

Refactor `generateIdeaBatch` so the body that does LLM + insert is an inner async function `runGenerateIdeaBatch(...)`.

When `opts.likeIdeaId != null`:

1. `const key = `${brandProfileId}:${opts.likeIdeaId}``
2. If `riffInflight.has(key)`, `return riffInflight.get(key)!`
3. Else `const p = runGenerateIdeaBatch(...).finally(() => { riffInflight.delete(key) })`; `riffInflight.set(key, p)`; `return p`

Non-riff path calls `runGenerateIdeaBatch` directly (no map).

**Rationale.** Same process, overlapping HTTP handlers share one Promise → one LLM invoke → one insert set. After `finally`, a new click creates new work (decision C).

### 4.2 Client riff pending

Replace the bare `generateIdeas` call in `IdeaCard` with a mutation owned by `PlanScreen` (or pass `onRiff` + `riffingId`):

```ts
const riffMut = useMutation({
  mutationFn: (ideaId: number) =>
    generateIdeas(effectiveBrandId!, { like_idea_id: ideaId }),
  onSuccess: (r) => { invalidate(); toast.success(`${r.ideas.length} riffs`) },
  onError: (e: Error) => toast.error(e.message),
})
// IdeaCard: disabled={riffMut.isPending && riffMut.variables === idea.id}
```

TanStack Query v5: `variables` holds the last/current mutation variable — use that to scope pending to one card. If concurrent riffs on *different* parents must be allowed simultaneously, use `useMutation` with a `Set` of pending ids via `onMutate`/`onSettled`, or multiple mutation observers. **Chosen default:** one riff at a time per screen is acceptable; if `variables === idea.id` only disables that card, a second card can still fire while the first is pending (two different keys on server). Prefer allowing parallel riffs on different parents: track `pendingRiffIds: Set<number>` in `onMutate` / `onSettled`.

### 4.3 PlanScreen structure after change

```
[ Header: Plan | brand | account? | Calendar ]
[ Cadence: N of P this week ]
[ Compose: steer · pillar · format · count · Generate · My own idea ]
[ Tabs: Board | Shortlist | Dismissed ]
[ Scroll: batches → IdeaCards ]
```

`days` = `useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(mondayOf(new Date()), i)), [])` — **fixed to current week**, not navigable. No `weekStart` state.

Cadence query:

```ts
const weekStart = useMemo(() => mondayOf(new Date()), []) // or recompute on focus — static per mount is fine
const from = isoDay(weekStart)
const to = isoDay(addDays(weekStart, 7))
const calQ = useQuery({ queryKey: ['calendar', from, to, effectiveBrandId, accountId], ... })
const plannedCount = calQ.data?.posts.length ?? 0
```

Remove: `navigate` usage for Craft from day cells (may still be unused — drop import if unused). Remove `Post` / `resolveNextStep` / `FormatGlyph` on day cells; keep `FormatGlyph` on idea cards.

### 4.4 Design tokens / patterns to copy

- Header minHeight 52, `--surface`, `--border` — CalendarScreen header.
- Field: `borderColor: var(--control)`, `rounded-[var(--radius-control)]`.
- Accent button: `background: var(--accent)`, white text — Calendar “Plan this week”.
- Tabs: InboxScreen underline + badge pattern.
- Icons: `Star`, `X` from lucide-react at 16 / 1.5 (already).

### 4.5 Docs

Edit [`docs/features/idea-to-post-flow/IMPLEMENTATION.md`](../idea-to-post-flow/IMPLEMENTATION.md) **F6** (and any acceptance bullets that require Plan week strip) to: Plan shows cadence line only; scheduling via Add to day; week grid on Calendar.

---

## 5. Detailed implementation steps

### S1 — Extract `runGenerateIdeaBatch` + riff coalesce map

- **Where:** `server/src/services/ideas.ts`
- **How:** Move current `generateIdeaBatch` implementation into `async function runGenerateIdeaBatch(...)`. Export `generateIdeaBatch` as wrapper that applies the Map when `likeIdeaId` is set. Ensure `finally` deletes the key on both resolve and reject.
- **Result:** Overlapping riffs share one Promise.
- **Depends on:** nothing.
- **Constraint:** Do not coalesce non-riff generates.

### S2 — Concurrent riff tests

- **Where:** `server/src/__tests__/ideas-routes.test.ts` (extend) **or** new `server/src/__tests__/ideas-riff-coalesce.test.ts` using the same temp DB + `vi.mock('../skills/model')` pattern.
- **How:** Make `invoke` wait on a deferred Promise. Fire two `fetch` POSTs with the same `like_idea_id` without awaiting the first. Resolve the deferred. Assert `invoke` call count === 1 and both responses share `batch_id` and idea ids. Then a third POST after settle → `invoke` count === 2 and new `batch_id`.
- **Result:** F1 verified.
- **Depends on:** S1.

### S3 — Client per-idea Riff pending

- **Where:** `client/src/routes/PlanScreen.tsx`
- **How:** Lift riff into `useMutation` + `pendingRiffIds` Set (or `variables` if serializing). Pass `riffPending` / `onRiff` into `IdeaCard`. Disable button; label `Riffing…`; `aria-busy={true}`.
- **Result:** F2.
- **Depends on:** nothing (can parallel S1).

### S4 — Remove week grid and week navigation

- **Where:** `client/src/routes/PlanScreen.tsx`
- **How:** Delete week nav buttons, day grid JSX, DnD handlers, `byDay`, format/pillar count breakdowns used only by the grid, `weekStart` state, `weekLabel` import if unused, `unscheduleIdea` import if unused, `resolveNextStep` / day Craft. Keep `scheduleIdea` on cards. Replace `days` with current-week memo. Keep thin cadence using `listCalendar`. Remove `data-testid="plan-day"`.
- **Result:** F3, F4, F5, F6.
- **Depends on:** nothing (UI). Prefer after S3 to avoid merge conflicts in the same file — do S3+S4+S5 in one PlanScreen pass if single implementer.

### S5 — Plan UX polish (header, compose, cards, cue)

- **Where:** `client/src/routes/PlanScreen.tsx`
- **How:** Implement F7–F12. Action order: Shortlist, Add to day, Riff, Dismiss. Parent cue from in-memory map: `const topicById = useMemo(() => new Map(ideas.map(i => [i.id, i.topic])), [ideas])` — note Board list includes shortlisted, so parent often present; if riffing from Shortlist tab, parent is in that list. For Board, riff children appear as `new` with parent possibly still on board.
- **Result:** F7–F12.
- **Depends on:** S4 structure.

### S6 — Update Idea → Post F6 docs

- **Where:** `docs/features/idea-to-post-flow/IMPLEMENTATION.md`
- **How:** Rewrite F6 and any acceptance criteria that say Plan shows 7 days / drag-drop. Point to this feature doc for the refinement.
- **Result:** T5.
- **Depends on:** S4 conceptually.

### S7 — Verify

- `pnpm --filter server exec vitest run` on ideas riff tests.
- `pnpm --filter client exec tsc --noEmit` (or repo typecheck).
- Manual: Plan has no day grid; Add to day works; double-click Riff → one toast / one batch; second deliberate Riff after idle → new batch; Calendar link works.

---

## 6. Business rules and edge cases

| Case | Behaviour |
|------|-----------|
| Double-click Riff (same parent, overlapping) | One LLM; both HTTP responses identical batch |
| Riff fails (502) | Map key cleared; client toast error; retry allowed |
| Second Riff after success | New batch of up to 3; prior riff rows remain (`new` unless dismissed) |
| Riff while parent dismissed | Still allowed if UI shows Restore path only on dismissed tab — Riff is hidden on dismissed tab today; keep that |
| Cross-brand `like_idea_id` | Existing 400 — unchanged |
| Unknown `like_idea_id` | Existing 404 via `getIdea` — unchanged |
| Add to day on already scheduled idea | Idea leaves board (`status=scheduled`); card disappears from Board/Shortlist on invalidate |
| Add to day invalid date | Server 400 — unchanged |
| Cadence with zero posts | `0 of N this week` |
| Brand with no `posts_per_week` | `0 planned this week` (or `{n} planned this week`) |
| Multi-instance Node | Coalesce is per-process only — accepted (local-first single server) |
| Parent topic not in loaded list | Omit “Riff of …” cue |
| Generate ideas (non-riff) double-click | Existing `generateMut.isPending` disables Generate — keep |

---

## 7. Constraints and compatibility

**Preserve**

- `POST /api/ideas/generate` request/response shape.
- Riff count = 3; `source='riff'`; `parent_idea_id` linkage.
- Near-duplicate drop behaviour and `dropped` count.
- `scheduleIdea` / policy `calendar.commit` + `post.draft`.
- Tab semantics: board = `new|shortlisted`, shortlist = `shortlisted`, dismissed = `dismissed`.
- Test ids: `generate-ideas`, `idea-card`, `shortlist-idea`, `schedule-idea-select`. **Remove** `plan-day`.

**Do not modify (unless required for compile)**

- `CalendarScreen.tsx` behaviour (link target only).
- `PostScreen.tsx`, pipeline, migrations.
- Dead `Dashboard` / `PostStudio` / `CalendarWeek` (S18 needs separate approval).

**Security / isolation**

- Ideas remain scoped by `brand_profile_id`. Coalesce key includes brand id so ids cannot collide across brands.

**Approval**

- None beyond this plan for the listed scope.

---

## 8. Requirement-to-implementation mapping

| Requirement | Tasks | Verification |
|-------------|-------|--------------|
| F1 Riff coalesce | S1, S2 | Concurrent fetch test: 1 invoke, same batch_id; third call new batch |
| F2 Client pending | S3 | Manual / RTL: button disabled + Riffing… while pending |
| F3 Board-only | S4 | No `plan-day` in DOM; no week nav |
| F4 Add to day | S4, S5 | Select still schedules; current week options |
| F5 Calendar link | S5 | Link to `/calendar` |
| F6 Cadence line | S4 | Text line with count; no cells |
| F7–F10 Chrome/cards | S5 | Visual match DESIGN / Calendar+Inbox peers |
| F11 Parent cue | S5 | Cue when parent in memory |
| F12 Empty/loading | S5 | Skeleton + per-tab empty copy |
| T1–T3 Coalesce rules | S1, S2 | Unit/route tests |
| T4 Design tokens | S5 | No new accent; lucide only |
| T5 Doc F6 | S6 | Doc text updated |

---

## 9. Acceptance criteria

1. On `/plan`, there is **no** 7-day strip and **no** Prev/Today/Next week controls.
2. Header reads **Plan** (not a week range) and offers **Calendar**.
3. Cadence line shows planned count for the current week without day cells.
4. **Add to day…** on a card schedules into that date; idea leaves the board; post appears on Calendar for that day.
5. Double-clicking **Riff** (or two overlapping API calls) produces **one** LLM invoke and one shared batch.
6. After the first riff finishes, clicking **Riff** again creates a **new** batch (new ideas).
7. While riffing, that card shows disabled **Riffing…** with `aria-busy`.
8. Generate / shortlist / dismiss / manual idea still work.
9. UI uses existing tokens; no emoji in chrome; accent only on Generate and active tab marks / shortlist-on.
10. Idea → Post F6 doc matches board-only Plan.

---

## 10. Testing strategy

### New / extended server tests

- **Concurrent riff coalesce** (S2): deferred `invoke`, two parallel POSTs, assert single invoke + identical `batch_id`; third POST after await → second invoke.
- Optional: riff failure clears latch — first invoke rejects, second POST after reject invokes again.

### Client

- No existing `PlanScreen` RTL file. Prefer:
  - Manual smoke for grid removal + riff pending, **or**
  - Light RTL test mocking `../api` that asserts `plan-day` absent and Riff disables while a slow `generateIdeas` promise is held (optional, nice-to-have).

### Regression

- Existing `ideas-routes.test.ts` board + generate still pass.
- `pnpm typecheck` / client `tsc --noEmit`.

### Not required

- E2E Playwright for this slice.
- Multi-process coalesce tests.

---

## 11. Risks and unresolved questions

| Risk | Mitigation |
|------|------------|
| Operator still expects to drag ideas onto days on Plan | Cadence line + Calendar link + Add to day; copy can say “Place on Calendar” only if empty state needs it — keep minimal |
| Parent cue often missing when parent dismissed | Accept omit; do not fetch |
| `pendingRiffIds` vs single `variables` | Prefer Set so two parents can riff in parallel; server map keys differ |
| Cadence `listCalendar` feels like “calendar still on Plan” | It is count-only; if product later objects, delete the query and show only Calendar link (F6 degrades gracefully) |
| Line numbers drift | Recheck before edit; working tree may still be dirty from Idea → Post |

**Unresolved:** none that block implementation — decisions C and A are locked.

---

## Implementation checklist (ordered)

1. S1 server coalesce  
2. S2 coalesce tests  
3. S3–S5 PlanScreen (pending + remove grid + UX)  
4. S6 doc F6  
5. S7 typecheck + vitest + manual smoke  
