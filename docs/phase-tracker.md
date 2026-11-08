# Phase tracker — unfinished tasks

Last updated: 2026-11-07. Source of truth for what's left in each phase. Checked items are done; unchecked are outstanding. See the full specs in the plan (`/Users/ashwin/.claude/plans/the-goal-of-this-sleepy-hearth.md`) and `docs/phase1-plan.md`.

---

## Phase 0 — Foundations and safety

Status: **complete.** DB migrations + `schema_migrations`, `DB_PATH`/`busy_timeout`, `assertEditable`, LLM adapter, Runware image, Vitest, TanStack Router/Query, design tokens, status glossary, screen stubs all in place.

---

## Phase 1 — Content quality and the review surface

Engine / platform wiring:
- [x] Task 1 — Wire `generation/pipeline.ts` into `agent/start-run.ts` (default path; legacy ReAct behind `AGENT_MODE=loop`)
- [x] Task 2 — Persist `PipelineReview` to `post_reviews` (+ migration 006 `overall_score`); research sources + hook alternates into `agent_output`
- [x] `GET /api/posts/:id/review` endpoint (exists in `http/routes/post-actions.ts`)

PostScreen (Task 3):
- [x] 3a — Research badge (web → "N sources", model → "Unsourced") + sources list in Agent notes
- [ ] 3b — Run link ("View run →") — **blocked:** `Post` exposes no `run_id`; `ActivityScreen` has no deep-link to a specific run. Needs schema/route work.
- [ ] 3c — Version diff panel — **unblocked:** Phase 2 now writes `post_versions` + `GET /versions`/`/diff`; wire the PostScreen panel.

Remaining UI:
- [x] Task 4 — BrandScreen section tabs (Basics / Voice / Look / Rubric / Advanced) in `BrandProfiles.tsx`; few-shot example manager (already existed, now in Voice tab); `BrandSwatchCard` live preview (brand colors + fonts + sample hook) in Look tab
  - [ ] Field-by-field diff + Accept/Revert on AI generate — **deferred:** current flow overwrites all fields; per-field diff over ~20 fields is a larger build
- [x] Task 5 — SetupScreen 5-step wizard (brand → models health → IG connect → budget → first week); auto-advances, progress bar, redirects to Inbox when complete
  - [ ] Global route guard (force `/` → `/setup` until complete) — **deferred:** risks trapping navigation; wizard is reachable at `/setup`. Decide whether to add a hard guard or a dismissible Home banner.
- [x] Task 6 — `pnpm eval` harness in `server/evals/`: 5 contrasting brand fixtures (6 topics + rubric + gold post each), `checks.ts` (reuses prod `lintDraft`/`IG`/`findBait` + brand-aware checks), `run.ts` (`--fixture`/`--models`/`--prompt`/`--baseline`/`--n`, builds BrandContextV2 from fixture without DB, cross-brand leak detector), `report.ts`, `labels/pairs.json`. Env-gated LLM response cache (`llm/eval-cache.ts` + no-op block in `adapter.ts`, active only under `EVAL_CACHE_DIR`). Verified: main + eval typecheck exit 0, 30/30 tests pass, fixtures leak-clean. Run: `cd server && pnpm eval --fixture 02-b2b-saas`

Tests (vitest, `pnpm --filter server test` — 46 cases total):
- [x] `src/__tests__/brand-context.test.ts` (7) — `renderContext` section rendering, priority ordering, whole-section budget drop (no mid-section truncation); `assertVisualIdentityReady` 422 on empty palette / missing render_style. Hermetic (own temp `DB_PATH` + dynamic import).
- [x] `evals/checks.test.ts` (9) — `runChecks` clean pass, banned words, emoji policy, trigram duplicate-hook; `findForbiddenTerms` leak detection (incl. slide text). Added `evals/**/*.test.ts` to the vitest include.
- [ ] Pipeline end-to-end — needs `generateObject` mocked (6 LLM call sites); not yet covered
- [ ] `GET /api/posts/:id/review` returns the persisted row — needs an HTTP/supertest harness; not yet covered
- [ ] Stale `server/test/` dir (4 files, not in the vitest include) — migrate into `src/__tests__/` or delete

Exit criteria still open:
- [ ] `pnpm eval --baseline` shows ≥70% pairwise wins + 100% deterministic pass, no cross-brand leaks
- [ ] Manual brand-1 voice/overlay check
- [ ] New screens pass `inspect.mjs --app` with 0 FAIL

---

## Phase 2 — HITL integrity, automation and budget

Status: **complete (Chunks 1–5 wired).** Plan: `docs/phase2-plan.md`.

Already built before wiring: DB schema, job runner mechanics, SSE, `expected_version` 409, budget routes, screens.

Shipped 2026-11-08:
- [x] **Chunk 1 — jobs routing.** `agent-run` / `generate-media` enqueue by default; job worker executes inline; MCP prefers `ApiClient` HTTP (fallback `MCP_EMBEDDED_WORKER=1`); `GET /api/jobs` + `/:id`. Tests: dedupe, lease claim, backoff, recovery, unknown-kind dispatch.
- [x] **Chunk 2 — versions/snapshots.** `bumpAndSnapshot` on transitions + PATCH; `GET /versions` + `/diff`; proposed versions on concurrent agent write. Tests: bump, diff, proposed-on-conflict.
- [x] **Chunk 3 — approvals/media gate.** Copy approve writes `approvals`; media approve records before stage; `staged`+scheduler+publish require current-version media(+copy) approval; judge override_reason. Tests: gate, scheduler skip, stale version, override.
- [x] **Chunk 4 — actor/events.** `HistoryActor` on versions/approvals/runs; MCP client name on enqueue; SSE change events carry latest actor. Tests: actor columns + activity + scheduler actor.
- [x] **Chunk 5 — budget enforcement.** `preflightPaidJob` downgrade→block in `runJob`; `spend_ledger` helpers; budget-aware `fill_week` reel cap. Tests: downgrade, block-at-cap, prod/eval sum, reel reduction.

Gap-fix pass (2026-11-08, A→C→B→D):
- [x] A1 artifact-hash gate on publish (+ no version bump on media_ready/staged)
- [x] A2 `fetch_media` job enqueue (async default; worker self-calls inline)
- [x] A3 content transitions vs media status bumps clarified; PATCH still snapshots
- [x] A4 judge override covered in approvals tests
- [x] C stronger jobs/actor/approvals/versions tests
- [x] B run actors + MCP client name + ApiClient app_settings token fallback
- [x] D PostScreen versions/diff + job strip; MCP actor chips

Still open (cross-cutting):
- [ ] Publish idempotency: persist `instagram_creation_id` before create; check container on retry (partial).
- [ ] Design: phone layout (bottom bar + mobile Inbox).
- [ ] Full two-process lease contention / mock Graph publish E2E / inspect.mjs.

---

## Phase 3 — Creative studio (Konva)

Status: **complete (A–D + spec-conformance gap closers).** Plan errata vs `docs/phase3-plan.md`:

- **Slides → pages** is `upgradePostToScene` (joins `post_slides`), not `upgradeCanvasDoc` (single CanvasDoc → one page).
- **`upgradeCanvasDoc` idempotency** needs an explicit `version === 2` guard (shipped); raw v2 without the guard would crash on `.layers`.
- **Golden parity** is an optional spike (`GOLDEN=1` + playwright); committed B deliverable is endpoint + hash + server pixel regression.
- **Client smoke** is non-Konva (history/inspector harness); pure logic is in `server/src/__tests__/scene-*.test.ts` after `pnpm --filter shared build` (pretest).
- **History** in Studio extracts shared `pushHistory`/`undo`/`redo`; image layers use a manual `HTMLImageElement` loader (no `use-image`).

- [x] **Chunk A** — zod schema, `resolve.ts`/`fitText`, `upgradePostToScene` backfill, hermetic tests in server vitest.
- [x] **Chunk B** — `/render`, `sceneHash`, server pixel regression; golden gated/optional.
- [x] **Chunk C** — pure `editor.ts` + templates; Konva wiring; non-Konva client smoke.
- [x] **Chunk D** — reel composite, studio AI actions, ReelTimeline, v1 deletion + import guard.

Review fixes (2026-11-08, 101 server + 3 client tests pass):
- **B — per-page hash:** `scenePageHash` now hashes each page's own content (+ size + resolved tokens), not the whole-doc `sceneHash`. Editing one carousel slide no longer invalidates the other pages' cached renders. New independence tests in `render-hash.test.ts`.
- **D — reel audio:** `compositeReelFromScene` now maps `0:a?` alongside `[vout]`; previously `-map [vout]` silently dropped the base clip's audio track.
- **D — tested/prod mismatch:** removed the unused `timelineSegments`; production and tests now share `overlayWindows` (one window per visible layer), so the green test actually guards the composite path.
- Not changed (noted, low): `offBrandColors` flags any non-`token:` color even when it equals a brand token (its `_tokens` arg is unused by design); overlay PNGs use a transparent `#00000000` background (works via skia 8-digit hex — worth a one-off visual check).

Spec-conformance gaps (review 2026-11-08) — plan in `docs/phase3-gaps-plan.md`. **All 4 chunks closed 2026-11-08** (134 server + 6 client tests pass, 4/4 typechecks clean):
- [x] **Ch.1 — guides.** `shared/src/scene/safe-zones.ts`: `safeZones(format,size)` → `{ safeContent, unsafe[] }`; `REEL_SAFE` moved here as the single source (re-exported into `server/src/instagram-rules.ts#IG.reelSafe`, no behavior change). Konva overlay + toggle (`Crop` icon) in `SceneCanvas`/`StudioEditor`. Tests: `safe-zones.test.ts` (5) — reel band geometry, feed inset, carousel parity, in-bounds for all formats.
- [x] **Ch.2 — entry points.** `EntryPicker` now has 3 tabs: From scratch (existing) · **From a brief** (textarea → `createPost` + `studioAction(auto-layout)` → opens editor on the returned scene) · **Fully AI** (`createPost` + `agentRun` → new `{kind:'generating'}` root mode polls `getRun` every 1.5s, transitions to edit once `succeeded`). Guarded a race where the post-query effect would snap back to 'edit' mid-generation. Tests: `StudioScreen.entry.test.tsx` (3) — tabs render, brief flow calls the right APIs, fully-AI shows the generating screen.
- [x] **Ch.3 — page ops + multi-select.** `reorderPages`/`duplicatePage` (pure, in `editor.ts`); page strip got drag-to-reorder + a duplicate button. `duplicateSelected`/`copySelected`/`pasteClipboard` now operate over the full `selectedIds` (was `[0]` only); `deleteSelected` already did. Tests: `scene-editor.test.ts` (+9) — page reorder/duplicate, multi-layer duplicate.
- [x] **Ch.4 — migration + verify.** `upgradePostToScene` gained a `prompt_vars` fallback (feed/carousel/reel) used when canvas_json and slides are both empty; backfill passes it through. Fixed a real bug found along the way: `SceneCanvas`'s Transformer-binding effect threw when a ref wasn't a real Konva node (hardened with a `typeof` guard — also fixed a stale/misleading doc comment claiming one shared renderer; corrected in `scene-render.ts`'s header to describe the actual architecture (server owns the one export/render path; the editor is react-konva; the golden test is a parity proxy, not a live-editor comparison). `inspect.mjs --app` on Studio **not run** (needs a live dev server + the design skill — deferred, not blocking). Tests: `scene-backfill.test.ts` (+2) — feed and carousel prompt_vars backfill.
Met and not re-listed from the original review: schema, assets table, resolve/fitText, golden test, v1 deletion, reel composite, AI actions, 11 templates, brand kit/uploads/inspector/feed view, snapping, undo/redo, keyboard shortcuts.

---

## Phase 4 — Insights and learning loop

Status: **not started.**

Engine:
- [ ] Insights scopes + daily token refresh; `ig_*` tables; sync jobs; performance digest into planner/judge
- [ ] OAuth: add `..._manage_insights` + `..._manage_comments` scopes; lazy `DEFAULT_SCOPES`; reconnect banner; daily `refresh_token` job

UI:
- [ ] Insights screen (finding line, stat strip, follower chart w/ publish markers, leaderboard, lift charts, best times, audience); post Performance tab; "what the agent learned" toggles; account summary on Home

---

## Phase 5 — MCP surface and polish

Status: **not started.**

Engine:
- [ ] MCP becomes thin adapter over `ApiClient`; new tools (`bootstrap_niche_page`, post/scene/media/job/insights tools); resources; prompts; `ui_url` in results; integration test; docs

UI:
- [ ] `ui_url` links open the exact screen; attribution polish; phone polish on every screen

Design:
- [ ] Accessibility sweep with axe; before/after capture report

---

## Cross-phase (ongoing)
- [ ] Spend tracking from Phase 0; $10/month cap enforced from Phase 2; eval spend tracked separately (`budget_scope=eval`)
- [ ] Each phase ends green on `pnpm typecheck`, `pnpm test`, Playwright smoke tests, screen checks
