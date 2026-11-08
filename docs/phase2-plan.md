# Phase 2 — HITL Integrity, Automation & Budget: Revised Implementation Plan

Audit date: 2026-11-08. Based on a full read of the Phase 2 source. **Phase 2 is far more built than the tracker implied** — the DB schema, job-runner mechanics, SSE, optimistic-concurrency checks, budget routes, and all the screens exist. The gap is *wiring*: the safety machinery is built but the real execution path bypasses it. Work is divided into **5 chunks**, each with its own tests.

---

## What already exists (do not rebuild)

| Area | File | State |
|---|---|---|
| **DB schema** | `002_phase0.sql`, `004_phase2.sql` | `jobs` (lease_owner/lease_expires_at/dedupe_key UNIQUE), `approvals` (stage copy\|media), `post_versions` (snapshot + actor_*), `spend_ledger` (budget_scope, estimated), `activity` view (unions versions/approvals/iterations/runs/auth), budget seed rows, `posts.version` column. |
| **Job runner** | `server/src/jobs.ts` (328 LoC) | `enqueueJob` (dedupe), `claimJob` (`BEGIN IMMEDIATE` + lease), `renewLease`/`completeJob`/`failJob` (backoff), `recoverExpiredLeases`, worker + scheduler loops, `startJobWorker()` called at `server.ts:256`. Handlers for `agent_run` + `publish_post` only. |
| **Scheduler** | `jobs.ts:schedulerTick` | Publishes due `staged` posts (`scheduled_at <= now`), dedupe `publish:<id>`. **Does not check media approval.** |
| **Optimistic concurrency** | `http/routes/posts.ts:84` | PATCH honors `expected_version` → 409 on mismatch. |
| **Events** | `http/routes/events.ts` (97 LoC) | SSE `text/event-stream`, poll-diff "change" events with affected resource kinds. |
| **Budget** | `http/routes/budget.ts` | `GET /api/budget`, `/budget/settings`, `POST /api/estimate` → `{ would_exceed }`. Advisory. |
| **UI** | `routes/{Inbox,Home,Calendar,Settings,Activity}Screen.tsx` | All substantial (323–724 LoC), not stubs. |
| **Publish** | `instagram-publish.ts`, `orchestrator.ts` | `instagram_creation_id` column + references exist. |

---

## The core problem: the safety path is built but bypassed

- **`enqueueJob` has zero callers outside `schedulerTick`.** `start-run.ts:137` runs the agent **inline** (`void (async () => …)`); `mcp-server.ts:149` calls `startAgentRunOnPost` **directly**. So two processes write to one SQLite file with no lease coordination — exactly the risk the job runner exists to remove. `handleAgentRun` is effectively dead; `generate_media` is in the `JobKind` union with **no handler and no enqueuer**.
- **Nothing writes `approvals`.** `/:id/approve` only `transitionPost(…, 'approved')` (copy). There is no media-stage approval, the scheduler publishes without checking one, and publish never verifies an approved artifact. The media gate — Phase 2's headline HITL guarantee — does not exist.
- **Nothing writes `post_versions`.** No snapshot writer; `posts.version` has no bump path (the `001` trigger bumps `revisions`, not `version`). So `expected_version` is checked against a value that never changes, the version-diff UI (PostScreen 3c) has no data, and the `activity` view's `post_version` rows are always empty.
- **Actors aren't populated.** `runs`/`jobs`/`post_versions`/`approvals` have `actor_*` columns but writers pass null; MCP `clientInfo` is never captured.
- **Budget isn't enforced.** The runner runs paid jobs with no pre-flight; no tier downgrade or block; `spend_ledger` writes from real calls are unverified.

---

## Chunk 1 — Route all execution through the job runner

**Goal:** one worker (Express) actually does the work; Express and MCP only *enqueue*. This is the SQLite-concurrency fix.

**Files:** `agent/start-run.ts`, `mcp-server.ts`, `jobs.ts` (add `generate_media` handler + enqueuers), `services/api-client.ts` (new, the enqueue seam), `http/routes/jobs.ts` (new: `GET /api/jobs`, `/jobs/:id`).

**Work:**
1. `start-run.ts` enqueues an `agent_run` job (`dedupe_key: agent_run:<postId>`) instead of running inline; return the job id. Keep the inline function as the job *handler* body.
2. Add a `generate_media` handler (wrap the existing `services/media` flow) and enqueue it where fetch/generate-media is triggered.
3. MCP enqueues through a thin `ApiClient` (local HTTP to Express, token from `app_settings`) rather than calling `startAgentRunOnPost` — with `MCP_EMBEDDED_WORKER=1` as the fallback for a down server. This is also the remote-transport seam.
4. Expose `GET /api/jobs` / `/jobs/:id` for the live progress UI.

**Unit tests** (`jobs.test.ts`, hermetic temp DB):
- `enqueueJob` dedupes on an active `dedupe_key`; re-enqueues once a prior job is `done`/`failed`.
- `claimJob` under two simulated workers claims each job **exactly once** (lease contention).
- `failJob` reschedules with backoff until `max_attempts`, then marks `failed`.
- `recoverExpiredLeases` re-queues a `running` job whose lease expired.
- `runJob` dispatches each `JobKind` to its handler; unknown kind → `failed` (no throw).

## Chunk 2 — Versions, snapshots & optimistic concurrency

**Goal:** make `posts.version` real so `expected_version`, the diff UI, and proposed-version-on-conflict all work.

**Files:** `orchestrator.ts` (bump + snapshot inside the write path), `http/routes/posts.ts`, a `services/versions.ts` helper, `http/routes/post-actions.ts` (`/:id/versions`, `/:id/diff`).

**Work:**
1. On every accepted post write/transition: increment `posts.version` and insert a `post_versions` snapshot (full post JSON + actor). One code path, so no write escapes it.
2. Wire `expected_version` to the real, now-incrementing value; on mismatch where a run produced the change, store the run output as a **proposed** version instead of overwriting operator edits.
3. `GET /api/posts/:id/versions` and `/diff?from=&to=` reading snapshots → unblocks **PostScreen 3c**.

**Unit tests** (`versions.test.ts`, hermetic DB):
- A write bumps `version` 1→2 and inserts exactly one `post_versions` row.
- `expected_version` mismatch → 409 and **no** write.
- Snapshot round-trips (parse back to the saved field values); `diff(fromN,toM)` reports changed fields.
- A concurrent run against an edited post creates a proposed version, not an overwrite.

## Chunk 3 — Approvals & the media gate (every format)

**Goal:** Phase 2's headline guarantee — nothing publishes without a copy **and** media approval of the current version.

**Files:** `http/routes/post-actions.ts` (approve-copy / approve-media), `services/approvals.ts` (new), `jobs.ts:schedulerTick` + `handlePublishPost` (gate checks), `orchestrator.ts` (transition guard).

**Work:**
1. `/:id/approve` writes an `approvals` row `stage:'copy'` for the current version; a new `/:id/approve-media` writes `stage:'media'`. A judge-failing post requires an `override_reason`.
2. `media_ready → staged` requires a media approval of the current version; `schedulerTick` and `handlePublishPost` both verify one exists, and publish checks the approved artifact hash (ties to the Phase 3 `sceneHash`).
3. Reels: the approval gate applies to the keyframe → final render step (closes the "unreviewed final reel" hole).

**Unit tests** (`approvals.test.ts`, hermetic DB):
- Approve-copy / approve-media insert rows with stage, version, actor.
- `staged` transition is rejected without a media approval of the current version; allowed with one.
- `schedulerTick` skips a staged post lacking media approval; enqueues one that has it.
- Approving a judge-failed post without `override_reason` is rejected; with one, allowed.
- Re-approving after a version bump is required (old-version approval doesn't count).

## Chunk 4 — Actor model, events & activity

**Goal:** every state change is attributable (You / MCP client / Scheduler) and surfaces live.

**Files:** `orchestrator.ts`, `runs.ts`, `services/approvals.ts`, `services/versions.ts` (thread an `Actor`), `mcp-server.ts` (capture `clientInfo`), `http/routes/events.ts` (carry actor + kinds).

**Work:**
1. Define `Actor = { kind: 'human'|'mcp'|'scheduler', name, client? }` and thread it into every `post_versions` / `approvals` / `runs` / `jobs` write (the `actor_*` columns already exist).
2. MCP captures `clientInfo.name` at connection and passes it as the actor on enqueued jobs.
3. `events.ts` emits change events tagged with actor + resource kind for TanStack Query invalidation and change toasts; the `activity` view already unions the tables.

**Unit tests** (`actor.test.ts`, hermetic DB):
- A version/approval/run written with an `Actor` persists `actor_kind`/`actor_name`/`actor_client`.
- The `activity` view returns rows carrying the actor for each kind.
- The scheduler's publish writes `actor_kind:'scheduler'`.

## Chunk 5 — Budget enforcement

**Goal:** the $10/month cap is enforced, not just displayed.

**Files:** `jobs.ts` (pre-flight in `runJob`), `services/budget.ts` (estimate + month-to-date + tier policy), `llm/adapter.ts` + media callers (write `spend_ledger`), `fill-week` (budget-aware mix).

**Work:**
1. Before a paid job runs, estimate its cost; if month-to-date + estimate > cap: **downgrade a tier** (8s→6s reel, carousel full-image→2 backgrounds); if still over, stop and mark the post **"needs budget approval"** — never overspend silently.
2. Record **actual** cost to `spend_ledger` from each LLM (token×price) and media (`includeCost`) call, `budget_scope` split prod/eval.
3. `fill_week` caps the format mix by remaining budget.

**Unit tests** (`budget.test.ts`, hermetic DB):
- Pre-flight downgrades the tier when the full estimate would exceed the cap.
- Pre-flight blocks (status → needs-budget-approval) when even the floor exceeds the cap.
- A completed paid call writes a `spend_ledger` row; `GET /api/budget` sums month-to-date correctly, prod vs eval separated.
- `fill_week` reduces the reel count when the remaining budget is low.

---

## Execution order & dependencies

| Chunk | Depends on | Effort | Why this order |
|---|---|---|---|
| 1 — jobs routing | — | ~6h | Removes the two-writer race; everything else runs as jobs |
| 2 — versions/snapshots | — | ~5h | Unblocks the diff UI and the approval-of-current-version check |
| 3 — approvals/media gate | 2 | ~6h | The headline HITL guarantee; needs real versions |
| 4 — actor/events | 1–3 | ~4h | Attribution for everything the prior chunks write |
| 5 — budget enforcement | 1 | ~5h | Pre-flight lives in the job runner from Chunk 1 |

1 and 2 are independent and can run in parallel. UI wiring (media-approval step, version-diff panel, bulk "approve N that pass", live progress strip via the SSE, actor chips, cost labels) rides on the chunk that provides its data — the screens already exist, so each is a wiring task folded into its chunk, not a rebuild. The deferred **PostScreen 3b run link** and **3c version diff** land with Chunks 1 and 2 respectively.

## Exit criteria (Phase 2)
- `pnpm typecheck` + `pnpm test` pass (server + client).
- **Lease-contention test**: two workers, one file DB → each job runs exactly once.
- Killing the worker mid-job → the job is recovered/retried via expired lease.
- **Publishing without both copy + media approval of the current version is rejected** (tested).
- A scheduled post publishes at its time against a mock Graph API, with publish idempotency (no duplicate container on retry).
- A job is **downgraded, then blocked**, at the cap (tested); `spend_ledger` reflects real spend.
- An MCP-created draft appears live with its **actor chip**; MCP cannot approve or publish.
- New/updated screens pass `inspect.mjs --app` with 0 FAIL at 1440/768/390.
