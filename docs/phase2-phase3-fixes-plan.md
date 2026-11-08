# Phase 2 / Phase 3 fix plan

Source: ground-truth review 2026-11-08 (two independent code audits against the master plan's
Phase 2 and Phase 3 specs). Findings are cited with file paths; re-verify line numbers before
editing since the audits read a point-in-time snapshot. Each chunk ships with its own tests, per
the house convention in `docs/phase3-gaps-plan.md`.

Priority tiers:
- **P0 — breaks the phase's core promise.** Fix first.
- **P1 — real correctness/data-integrity gaps.** Fix next.
- **P2 — polish / completeness.** Fix if time allows.
- **Deferred** — out of scope for a "fix pass" (design or spike-sized work); listed so it isn't lost.

---

## Chunk 1 (P0) — Close the Phase 2 approval bypass

The route the UI actually calls can publish without approvals, and bulk-approve skips the judge
filter and never records an approval. Both defeat Phase 2's core HITL guarantee.

1. **`POST /:id/publish-instagram`** (`server/src/http/routes/instagram-posts.ts`) must call the
   same `assertPublishApprovals` check `jobs.ts`'s `handlePublishPost` already uses, before doing
   any container/publish work. Currently only the job-queue path checks it.
2. **`POST /bulk-approve`** (`server/src/http/routes/posts.ts`):
   - Filter to posts whose current review/checks actually pass (reuse whatever `post_reviews.passed`
     / deterministic-checks gate the single-post approve path already uses) — don't approve a
     failing post via bulk.
   - Call `recordApproval` (`services/approvals.ts`) for each post approved this way, with the
     acting user as actor — right now bulk-approved posts end up `approved` with zero `approvals`
     row.
3. **Media approval is unreachable from the live UI.** `PostStudio.tsx` (which calls the real
   `approveMedia` API) isn't mounted on any route, and `PostScreen.tsx`'s single Approve button
   calls `/approve` even when status is `media_ready`, where `VALID_TRANSITIONS` doesn't allow
   `'approved'` — it 409s today. Add a distinct "Approve media" action to `PostScreen.tsx` for the
   `media_ready` stage that calls the existing media-approval endpoint (confirm/reuse whatever
   `jobs.ts`/`services/approvals.ts` already expects — don't invent a second approvals path).

**Tests**
- Route test: publishing a `staged` post with no copy/media approval via `/publish-instagram`
  is rejected (currently only covered for the job path).
- `bulk-approve` test: a mixed batch (some passing, some failing review) only approves the passing
  ones, and each gets an `approvals` row with the right actor.
- Client test: a `media_ready` post shows an "Approve media" action (not the copy-approve button),
  and clicking it doesn't 409.

---

## Chunk 2 (P1) — Publish idempotency, restart archiving, route guards

1. **Publish idempotency.** In `instagram-publish.ts`, persist `instagram_creation_id` to the post
   row immediately after the container is created — not only in the final success transition
   (currently done once, in `transitionPost(..., 'published', ...)` after everything succeeds). On
   retry, check for an existing `instagram_creation_id` and the container's status via the Graph API
   before creating a new container.
2. **`/restart` archives instead of deletes.** `post-actions.ts`'s restart handler currently runs
   `DELETE FROM post_slides` / `DELETE FROM iterations`. Add an `archived_at` (or
   `restarted_at`) column (or a boolean) to both tables, mark-not-delete on restart, and filter
   active queries by it. This is the exact bug Part A flagged as still open.
3. **Guard the raw routes.** `/:id/pending-upload` and `/:id/publishing` (`instagram-posts.ts`) have
   no actor/policy check at all — add the same `assertAllowed`-style guard the other mutating routes
   use.

**Tests**
- Idempotency test: mock Graph API to fail after container creation but before publish; retrying
  does not create a second container (asserted via call count / creation_id reuse).
- Restart test: post_slides/iterations rows still exist (marked archived) after `/restart`, not gone.
- Policy test: `operator_agent` (or an unauthenticated/wrong-role caller) is rejected on
  `/pending-upload` and `/publishing`.

---

## Chunk 3 (P0) — Make Studio's "Generate background" / "Generate variations" real

Today both handlers (`server/src/http/routes/studio.ts`) insert a placeholder asset row with
`url = 'prompt://<hash>'` and a note to run `fetch-media` manually — while the Studio UI presents
them as one-click, cost-labeled actions (`~$0.02`/`~$0.08`). A user gets a dead image.

1. Wire both handlers to the real media-generation path (the same `generate_media` job kind /
   Runware image call the rest of the app uses — reuse, don't reimplement) instead of inserting a
   placeholder. Match the app's existing async pattern: enqueue a job, return its id, let the client
   poll — the same shape just built for the Studio "Fully AI" entry point's `GeneratingScreen`.
2. Update `StudioScreen.tsx` so these two actions show a busy/polling state and resolve to the real
   generated asset once the job completes, instead of assuming a synchronous result.

**Tests**
- Server test: `generate-background` enqueues a real media-generation job and, once it completes
  (mocked Runware), the asset row has a resolvable URL, not `prompt://...`.
- Server test: `variations` produces N distinct real assets.
- Client test: clicking "Generate background" shows a busy state and ends with a real image layer,
  not an immediate placeholder.

---

## Chunk 4 (P1) — Wire the real scene migration into the live paths

`upgradePostToScene` (the backfill that correctly joins `post_slides`/`prompt_vars`) is only
exercised by a manual CLI script. The actual live paths — `GET /api/posts/:id/scene`,
`loadPostScene` (`generation/studio-actions.ts`), and `render/render-post.ts` — go through the
simpler `upgradeCanvasDoc`, which ignores `post_slides`/`prompt_vars`. A legacy carousel that was
never backfilled silently renders as an empty scene in Studio, in AI actions, and in the published
render.

1. Replace the `parseSceneJson`/`upgradeCanvasDoc` calls in those three call sites with
   `upgradePostToScene`, so any post is correctly upgraded on first access regardless of whether the
   one-shot script ran.
2. Write the upgraded result back to `scene_json` on first successful upgrade, so repeat reads take
   the fast path instead of re-deriving every time.
3. Fix the stale comment in `shared/src/scene/renderer.ts` (lines ~5-8) claiming the client calls
   the same Canvas 2D operations — this is the same false claim already corrected in
   `server/src/render/scene-render.ts` last session; it was never fixed in this twin file.

**Tests**
- Server test: a legacy post with only `post_slides` (no `canvas_json`/`scene_json`) returns a
  correct multi-page scene from `GET /:id/scene`, `loadPostScene`, and the render path — not an
  empty default.
- Server test: an already-migrated post (has `scene_json`) isn't needlessly re-upgraded (fast-path
  check, e.g. by spying on `upgradePostToScene` call count or timing).

---

## Chunk 5 (P2) — Budget-enforcement completeness

1. **Enforce re-roll limits.** `budget_max_image_rerolls`/`budget_max_reel_rerolls` are read/written
   in settings but have zero consumers. Count prior re-rolls per post+kind (e.g. from
   `spend_ledger` or `assets`) and block with a clear error once the cap is hit.
2. **Studio AI actions respect budget.** Look up `/api/budget` (or `/api/estimate`) before enabling
   the AI action buttons in `StudioScreen.tsx`; disable with the over-budget reason shown, per the
   plan's F.4 spec. Currently there's no budget lookup in that file at all.
3. **Prompt caching for brand context** (`llm/adapter.ts` / `brand-context.ts`) — add
   `cache_control` on the brand-context system block for Anthropic calls. Lower priority: a cost
   lever, not a correctness issue.

**Tests**
- Server test: the N+1th re-roll for a post is blocked with a clear error once the cap is reached.
- Client test: AI action buttons show disabled-with-reason when a mocked `/api/budget` response is
  near/over cap.
- (Best-effort) assert the cache-control flag is present on brand-context-bearing Anthropic calls.

---

## Deferred (not part of this fix pass)

- **Phone/responsive layouts** for every Phase 2 and Phase 3 screen — this is a full design-system
  effort (F.3/F.5), not a bug fix. Needs its own pass.
- **Main Risk #1 — the Konva server/browser text-matching spike.** Still genuinely undone: the one
  golden test that exists explicitly excludes text to dodge font-AA differences, which is exactly
  the question the spike exists to answer. This needs its own investigation (Playwright + font
  setup across both engines), not a quick fix bundled here.
- **Mock-Graph-API scheduled-publish E2E test** and **from-scratch/fully-AI publish-end-to-end
  test** — valuable but need a proper Graph API mock harness; worth a dedicated chunk once Chunks
  1–2 land (no point testing publish idempotency and the mock-Graph E2E separately if they can
  share a harness).
- **`inspect.mjs --app` runs** on Phase 2/3 screens — needs a live dev server session, not code
  changes.

## Suggested order

Chunk 1 → Chunk 3 (the two P0s, independent of each other, can be done in either order or in
parallel) → Chunk 2 → Chunk 4 → Chunk 5.
