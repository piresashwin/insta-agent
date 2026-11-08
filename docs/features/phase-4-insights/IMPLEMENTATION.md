# Phase 4 — Insights and the learning loop: implementation plan

Status: ready for implementation. Grounded in a direct audit of the codebase at
`/Users/ashwin/dev/instagram-agent` on 2026-11-08 (file:line citations below). Source spec: the
master plan (`/Users/ashwin/.claude/plans/the-goal-of-this-sleepy-hearth.md`), Part B "Phase 4:
Insights and learning loop", Roadmap table Phase 4, E.3 #7 (Insights screen), F.4 (Insights design
spec), and the Phase 4 exit criteria in "Verification".

**A note on API specifics.** This plan gives exact metric names and endpoints where the plan or the
existing codebase already states them (e.g. `views` not `impressions`, the `refresh_access_token`
endpoint). Meta's Graph API parameter names (e.g. exact `metric`/`breakdown` values for the
demographics endpoint) can drift and aren't pinned anywhere in this repo — the implementer must
verify exact parameter names against Meta's current Graph API docs for the connected app's API
version (`META_GRAPH_VERSION`, currently defaulting to `v21.0`) before shipping Chunk 3's audience
sync. This is flagged again in Risks.

---

## 1. Feature overview

Phase 4 closes the loop between what gets published and what the agent plans next. Today the app
publishes posts and records a single per-post engagement snapshot on demand
(`learn` table, `server/src/instagram-publish.ts:276-343`), but nothing syncs on a schedule, nothing
aggregates account-level trends, and nothing feeds performance data back into the planner or judge.
This phase adds:

1. Scheduled sync of per-post insights (at defined ages after publish), daily account metrics, and
   weekly audience demographics, stored in three new tables.
2. Token refresh so IG connections don't silently die after 60 days, plus the two missing OAuth
   scopes needed to read insights/comments at all.
3. A `PerformanceDigest` computed per brand, fed into the week planner and the hook judge.
4. A real `/insights` screen (currently a 9-line placeholder) and a `Performance` tab on post review.

## 2. Requirements

**Functional**

- F1. Instagram OAuth requests `instagram_business_manage_insights` and
  `instagram_business_manage_comments` in addition to today's scopes, and does so correctly even
  when `.env` is loaded after module import (today's lazy function isn't actually used).
- F2. Existing connections missing the new scopes are detected, and the UI shows a reconnect banner
  explaining why.
- F3. A daily job refreshes any IG access token expiring within 10 days, using Meta's
  `ig_refresh_token` endpoint, and clears `last_error` on success.
- F4. Published media (`ig_media`) is synced into a durable table, including a one-time import of
  pre-existing (pre-agent) posts from the connected account.
- F5. Per-post insights are polled at 1h, 6h, 24h, 72h, 7d and 28d after publish, then weekly out to
  90 days, using the correct (non-deprecated) metric set per `media_product_type`.
- F6. Account-level daily metrics (followers, reach, views, accounts_engaged, link taps) are synced
  once a day, re-syncing the last 3 days each time to absorb Meta's up-to-48h reporting delay, with
  a `final` flag distinguishing settled vs. still-adjusting rows.
- F7. Audience demographics are synced weekly, and are not computed/shown for accounts under 100
  followers (Meta's own API restriction).
- F8. A per-brand `PerformanceDigest` is computed from the above: a lift score
  `(saves + 1.5×shares + 3×follows) / reach` at the 7-day mark, compared against the brand's 30-post
  median, with top/bottom 5 posts and lift by format/pillar. Requires ≥8 published posts; otherwise
  explicitly labeled "not enough data."
- F9. The digest feeds the week planner (`fillWeekForBrand`) as a factual summary the planner can
  use to suggest ±1 changes to format mix, and feeds the hook judge via `ctx` so judging can
  consider what has actually worked for this brand.
- F10. `/insights` shows: account trend stat strip, a followers-per-day chart with publish-date
  markers, a leaderboard of posts by digest score linked to their post-review page, format/pillar
  lift, best posting times, and an audience panel (hidden under 100 followers with that reason
  stated).
- F11. Each post's review page gains a `Performance` tab (reach, views, saves, shares, comments,
  permalink), shown only once a post is published, with a "data delayed up to 48h" note.
- F12. Rate-limit responses from the Graph API back off using the job runner's existing retry
  mechanism rather than failing the sync permanently.

**Technical**

- T1. All new sync/refresh job kinds are unauthenticated-cost (no LLM/media spend) and must not be
  budget-preflighted, consistent with how `fetch_media`/`publish_post` are already exempted.
- T2. All sync jobs carry `SCHEDULER_ACTOR` and reuse the existing actor/attribution plumbing — no
  new actor kind is needed (`'scheduler'` already exists).
- T3. New tables follow the existing migration-file and naming conventions (`NNN_description.sql`,
  `server/src/db/migrations/`).
- T4. Graph API calls reuse the existing `igGet` helper and base-URL pattern rather than
  reimplementing HTTP/auth handling.
- T5. New shared types live in a dedicated `shared/src/insights/` module with its own barrel export,
  matching the `shared/src/scene/` precedent.

## 3. Existing implementation analysis

Verified by direct code reading (not the plan's prose, and not trusting `docs/phase-tracker.md`).

**OAuth / scopes** (`server/src/instagram-oauth.ts`)
- `getDefaultScopes()` (lines 21-26) reads `process.env` lazily — correct in isolation. But the
  module also exports `export const DEFAULT_SCOPES = getDefaultScopes()` (line 28), evaluated once
  at import time, and **this eager constant, not the lazy function, is what `buildAuthorizeUrl`
  actually uses** (line 108). So the "scope override has no effect until restart" bug the plan
  describes is real, just one layer removed from the original description.
- Current scopes: `instagram_business_basic,instagram_business_content_publish` (line 24) — missing
  `instagram_business_manage_insights` and `instagram_business_manage_comments`.
- No token-refresh logic exists anywhere; `refresh_token` on `instagram_conn` is always written as
  `NULL` (lines 242, 267).
- `instagram_conn` schema (`server/src/db/migrations/001_baseline.sql:3-20`): `id, account_id (TEXT
  UNIQUE NOT NULL), app_id, client_secret, redirect_uri, access_token, refresh_token, status,
  ig_username, page_id, last_error, token_expires_at, default_brand_profile_id, created_at,
  updated_at`. `token_expires_at` already exists and is populated on connect — no migration needed
  for it, but there's no column recording which scopes were actually requested/granted at connect
  time, needed for F2.

**Graph API call pattern** (`server/src/instagram-publish.ts`)
- Base URL: `` `https://graph.instagram.com/${META_GRAPH_VERSION || 'v21.0'}` `` (lines 15-18, same
  constant used in `instagram-oauth.ts:15-18`).
- Auth: `access_token` query parameter (not a header). Helper: `igGet<T>(path, token, params)`
  (lines 29-40) builds a `URL`, appends `access_token` plus any extra params, does a plain `fetch`,
  throws `Error(json.error.message)` on `!ok` or a present `.error`. **No rate-limit/backoff
  handling** — relies entirely on the caller/job-runner retry.
- `fetchMediaInsights(mediaId, token, mediaType)` (lines 196-214) already exists but uses the
  **deprecated metric set**: `impressions,reach,saved,shares,total_interactions,likes,comments,
  profile_visits` for non-reels and `plays,reach,total_interactions,saved,shares,likes,comments` for
  reels (lines 199-201) — confirms the plan's Part A finding is still accurate here, even though the
  adjacent `isReel` string-case bug it also flagged appears already fixed (`.toUpperCase() ===
  'REELS'`, line 198).
- This function is only ever called on-demand from `GET /:id/instagram/insights`
  (`server/src/http/routes/instagram-posts.ts:231-254` → `updateLearnEngagement`,
  `instagram-publish.ts:326-343`) — never from a schedule.

**`learn` table** (`001_baseline.sql:92-99`): `id, post_id, account_id, engagement (TEXT/JSON), hook,
caption, created_at`. Written on publish (`recordPublishForAnalytics`, `instagram-publish.ts:276-321`)
and updated by the on-demand route above. It has zero consumers in the planner or judge — accurate
for "never read by the learning loop," even though it isn't literally untouched.

**Job runner** (`server/src/jobs.ts`)
- `JobKind` is a closed union: `'agent_run' | 'publish_post' | 'generate_media' | 'fetch_media'`
  (line 25) — extending it is additive (add to the union, add a `case` in `runJob`'s switch,
  lines 338-355, add a `handleX` function).
- Budget preflight only runs for `job.kind === 'agent_run' || 'generate_media'` (line 315) —
  `publish_post`/`fetch_media` already skip it. New sync/refresh kinds are "free" simply by **not**
  being added to that condition; no new concept needed.
- `enqueueJob({kind, payload, post_id, run_id, priority, run_at, dedupe_key, max_attempts,
  budget_scope})` (lines 49-92): dedupe works by rejecting re-insertion while a non-terminal job with
  the same `dedupe_key` exists, and **freeing the key once the existing job reaches a terminal
  status** (lines 60-71) — so a dedupe key built from a date (e.g. `sync_account_insights:{account}:
  {date}`) can be safely re-enqueued on a later tick once the earlier job completes; this is exactly
  the behavior needed for "re-sync the last 3 days" (F6).
- `schedulerTick()` (lines 368-399) is the existing precedent for a periodic function that queries
  directly and enqueues jobs with per-entity dedupe keys; it currently runs on a 15s interval
  (confirm exact interval via `startJobWorker`/the timer setup near line 403+ at implementation time).
  Phase 4's sync scheduling should **not** reuse this same 15s tick (unnecessary load for
  hourly/daily/weekly cadences) — see Chunk 3 for a separate, coarser interval.
- `SCHEDULER_ACTOR` (`server/src/services/attribution.ts:14-18`) is already the actor used for
  scheduler-originated jobs; `HistoryActorKind` already includes `'scheduler'` (line 5).
- `jobs.post_id` is a nullable `INTEGER` — fine for per-post jobs; account-level jobs (daily/weekly
  sync, refresh) simply omit it.

**Migrations** (`server/src/db/migrations/`): `001_baseline` → `010_archive_on_restart`, one file per
numbered step, tracked via `schema_migrations`. The next Phase 4 migration should be
`011_phase4_insights.sql`.

**`posts` table** (`001_baseline.sql:35-75`) already has `instagram_media_id`,
`instagram_creation_id`, `instagram_permalink`, `instagram_shortcode`, `instagram_published_at`,
`instagram_children_ids`, `account_id` — a ready join surface from `ig_media` back to `posts`.
`brand_profiles` (`001_baseline.sql:165-188`) has no insights-related columns and no `account_id`
column — a brand maps to an account only indirectly, through posts (`posts.brand_profile_id` +
`posts.account_id`) and through `instagram_conn.default_brand_profile_id`. The digest (F8-F9) is
computed **per brand**, so it must derive the relevant account(s) by joining `posts` rather than
assuming a 1:1 brand:account mapping.

**BrandContext / planner integration points**
- `BrandContextV2` (`server/src/generation/brand-context.ts:40-56`) has no performance field today.
  `ContextSectionName` / `SECTION_PRIORITIES` / `SECTION_RENDERERS` (lines 196-296) is the extension
  point — `renderHooksMemory` is the existing precedent for a section that summarizes past data into
  prose for the prompt.
- `renderContext(ctx, sections, budget)` is called from `generation/pipeline.ts:167` (plan step) and
  again around the judge step (`judgeWithRubric`, `pipeline.ts:462`) — a new `'performance'` section
  needs to be added to the `sections` array passed at (at least) the plan call site.
- `fillWeekForBrand` (`server/src/skills/fill-week.ts:70-78`) calls `planWeekTopics({brandBrief,
  dates, pillars, niche, audience, defaultFormat, formatMix})` (`server/src/skills/week-plan.ts:98-104`)
  — a **flat options object, not `BrandContextV2`**. Feeding the digest into week planning is a
  *separate* integration point from the pipeline's `ctx`: add a `performanceSummary?: string` field
  to that options type and splice it into the prompt string built at `week-plan.ts:108-124`.

**Client API / routing**
- `getPostInstagramInsights` / `getPostInstagramComments` (`client/src/api.ts:460-481`) already call
  real, existing server endpoints (`GET /:id/instagram/insights`, `GET /:id/instagram/comments`,
  `instagram-posts.ts:231,260`) and are confirmed unused anywhere in the client outside `api.ts`
  itself — these are exactly what the new `Performance` tab (F11) should call; no new endpoint is
  needed for per-post performance display, only for the aggregated `/insights` screen.
- `client/src/router.ts:16,72-75,110` already registers `/insights` → `InsightsScreen`, which is
  currently a 9-line placeholder (`client/src/routes/InsightsScreen.tsx`, "Coming in Phase 1.") —
  **this file must be replaced, not created.**
- Data-fetching convention: `useQuery({queryKey, queryFn})` / `useMutation` +
  `queryClient.invalidateQueries`, per `client/src/routes/InboxScreen.tsx:6,127-128`.
- `client/package.json` has **no charting library** (no recharts/visx/d3/victory/nivo). One must be
  added — see Chunk 5's technical decision.

**Actor/budget hooks**: `HistoryActorKind` already covers `'scheduler'`; budget preflight is opt-in
per job kind and sync/refresh jobs simply aren't added to that list — no new "free job" concept
needs inventing (confirmed at `jobs.ts:315` above).

**MCP/shared scaffolding**: zero insights-related types or tools exist anywhere in `shared/src/` or
`mcp-server.ts` today. (MCP tool exposure for insights is Phase 5 scope per the roadmap — out of
scope for this plan; only the shared *types* are needed now, for the client and server to agree on
shapes.)

## 4. Proposed technical approach

- **New domain module, server-side**: `server/src/insights/` holding `graph-metrics.ts` (metric-set
  definitions + Graph API calls, reusing `igGet`), `sync.ts` (the four job handlers), `digest.ts`
  (the `PerformanceDigest` computation), and `scheduler.ts` (the coarser-interval tick that enqueues
  sync/refresh jobs). This mirrors the existing `server/src/services/*` separation convention
  (Phase 0's "move logic out of `server.ts`") rather than growing `jobs.ts` or `instagram-publish.ts`
  further.
- **New shared module**: `shared/src/insights/` with `types.ts` (digest shape, metric-row shapes used
  by both server responses and client rendering) and an `index.ts` barrel, matching
  `shared/src/scene/`.
- **Four new tables** in one migration (`011_phase4_insights.sql`): `ig_media`, `ig_media_metrics`,
  `ig_account_metrics_daily`, `ig_audience_snapshots`, plus one new column on `instagram_conn`
  (`granted_scopes TEXT`) to support the reconnect-banner check.
- **Four new job kinds**: `sync_media_insights`, `sync_account_insights`, `sync_audience_insights`,
  `refresh_token` — added to the existing `JobKind` union and `runJob` switch, each free of budget
  preflight.
- **A second, coarser scheduler tick** (e.g. every 30 minutes — see Chunk 3) separate from the
  existing 15s `schedulerTick`, since insights/refresh cadences are hourly/daily/weekly, not
  real-time.
- **BrandContext + week-plan extension**: a new `'performance'` context section, and a new
  `performanceSummary` field threaded into `planWeekTopics`'s options.
- **Client**: replace `InsightsScreen.tsx` with the real screen; add a `Performance` tab to the
  existing post-review screen (reuse the two already-written, already-correct API functions); add a
  charting library (decision in Chunk 5).

No existing table, route, or job kind is removed or renamed. This is purely additive except for the
two bug fixes explicitly called for by the plan (lazy-scope wiring, deprecated metric names), which
are corrections, not architecture changes.

## 5. Detailed implementation steps

### Chunk 1 — OAuth scopes, token refresh, reconnect signal

**1.1 Fix the lazy-scope bug.** In `server/src/instagram-oauth.ts`: stop exporting the eager
`DEFAULT_SCOPES` constant (or keep it only as a deprecated alias that re-reads `getDefaultScopes()`
on each access via a getter) and change `buildAuthorizeUrl` (line 108) to call `getDefaultScopes()`
directly at call time, not the module-level constant. Add `instagram_business_manage_insights` and
`instagram_business_manage_comments` to the scope list built there.
- Depends on: nothing.
- Result: a fresh `/connect` URL always reflects the current env-configured scopes, and now includes
  the two new ones.

**1.2 Record granted scopes.** Add `granted_scopes TEXT` to `instagram_conn` (Chunk 2's migration).
On successful OAuth callback (wherever `instagram_conn` is inserted/updated after token exchange —
locate the exact callback handler in `instagram-oauth.ts` at implementation time), store the scope
string that was requested at connect time (Meta's token exchange response does not reliably echo
back granted scopes for this login type, so "what we requested" is the honest, available signal).
- Depends on: 1.1 (so new connections get the full requested-scope string), Chunk 2 migration.

**1.3 Reconnect-needed check.** Add a small helper, e.g. `connectionNeedsReconnect(conn):
boolean`, that returns true when `granted_scopes` is null (pre-Phase-4 connection) or doesn't
contain both new scopes. Expose it on whatever endpoint already reports connection status (locate
the existing `GET /api/instagram/...` status route at implementation time) as a boolean field.
- Depends on: 1.2.

**1.4 Token refresh job.** New job kind `refresh_token`. Handler calls
`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>`
(per the plan's explicit endpoint; this call is unversioned — don't prefix it with
`META_GRAPH_VERSION`), updates `access_token`/`token_expires_at` on success, and sets `last_error` on
failure (don't let a failed refresh crash the job — a connection with a soon-to-expire token should
surface as a dashboard warning, not an unhandled exception). Dedupe key:
`` `refresh_token:${connection_id}:${date}` ``. Enqueued by Chunk 3's coarse scheduler for any
connection whose `token_expires_at` is within 10 days, at most once/day.
- Depends on: Chunk 3's scheduler tick existing to enqueue it; can be implemented/tested
  independently via direct `enqueueJob` calls first.

**Tests (Chunk 1)**
- `buildAuthorizeUrl` includes both new scopes and reflects an env override set *after* module
  import (regression test for the exact bug being fixed).
- `connectionNeedsReconnect` returns true for a connection with `granted_scopes = null` and for one
  missing either new scope; false when both are present.
- `refresh_token` handler: mocked Graph response updates `access_token`/`token_expires_at`; a mocked
  error response sets `last_error` and does not throw out of the job (job completes as
  failed-but-handled, matching the existing `failJob` retry/backoff path).

### Chunk 2 — Schema

New migration `server/src/db/migrations/011_phase4_insights.sql`:

```sql
ALTER TABLE instagram_conn ADD COLUMN granted_scopes TEXT;

CREATE TABLE IF NOT EXISTS ig_media (
  id                   TEXT PRIMARY KEY,          -- Instagram media id
  account_id           TEXT NOT NULL,
  post_id              INTEGER,                    -- NULL for imported pre-existing posts
  media_product_type   TEXT,                        -- FEED | REELS | CAROUSEL_ALBUM
  media_type           TEXT,
  permalink            TEXT,
  caption              TEXT,
  timestamp            TEXT,                        -- Instagram's published-at
  thumbnail_url        TEXT,
  is_imported          INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_ig_media_account ON ig_media(account_id);
CREATE INDEX IF NOT EXISTS idx_ig_media_post ON ig_media(post_id);

CREATE TABLE IF NOT EXISTS ig_media_metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id          TEXT NOT NULL REFERENCES ig_media(id),
  period_label      TEXT NOT NULL,   -- '1h' | '6h' | '24h' | '72h' | '7d' | '28d' | 'weekly_N'
  measured_at       TEXT NOT NULL,
  views             INTEGER,
  reach             INTEGER,
  saved             INTEGER,
  shares            INTEGER,
  likes             INTEGER,
  comments          INTEGER,
  total_interactions INTEGER,
  profile_visits    INTEGER,
  follows           INTEGER,
  watch_time        INTEGER,
  raw_json          TEXT,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(media_id, period_label)
);

CREATE TABLE IF NOT EXISTS ig_account_metrics_daily (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       TEXT NOT NULL,
  date             TEXT NOT NULL,   -- YYYY-MM-DD
  followers        INTEGER,
  reach            INTEGER,
  views            INTEGER,
  accounts_engaged INTEGER,
  link_taps        INTEGER,
  final            INTEGER NOT NULL DEFAULT 0,
  raw_json         TEXT,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT,
  UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS ig_audience_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            TEXT NOT NULL,
  captured_at           TEXT NOT NULL,
  follower_count_at_capture INTEGER,
  demographics_json     TEXT,
  created_at            TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ig_audience_account ON ig_audience_snapshots(account_id);
```

- `account_id` columns are `TEXT` to match `instagram_conn.account_id` (`001_baseline.sql:5`), not an
  integer FK — there is no separate `accounts` table in this schema.
- `ig_media_metrics` is `UNIQUE(media_id, period_label)` so a re-sync of the same slot is an
  upsert (`INSERT ... ON CONFLICT ... DO UPDATE`), not a growing duplicate history — the plan wants a
  *time series of slots*, not a log of every poll attempt.
- Depends on: nothing (first task, so later chunks can build against real tables).

**Tests (Chunk 2)**: a migration test asserting the four new tables and the `instagram_conn` column
exist after running migrations against a fresh temp DB (follow the existing migration-test pattern —
locate it via the Phase 0/2/3 migration tests already in `server/src/__tests__/` at implementation
time and mirror its structure).

### Chunk 3 — Graph API sync module, job kinds, scheduler

**3.1 Metric-set module.** `server/src/insights/graph-metrics.ts`:
- `mediaMetricsFor(mediaProductType: string): string` — returns the correct comma-joined metric
  list. Use `views` (not `impressions`/`plays`) per the plan's explicit instruction. Exact field
  names: for `FEED`/`CAROUSEL_ALBUM`, `views,reach,saved,shares,likes,comments,total_interactions,
  profile_visits,follows`; for `REELS`, the same set (Reels insights on the current Graph API expose
  `views` too, replacing the deprecated `plays`) — **verify this exact field list against Meta's
  current docs for `META_GRAPH_VERSION` before shipping**, since this is the one place this plan
  cannot verify against the live Graph API from inside the repo.
- `accountMetricsFields(): string` — the account-level daily metric list: `reach,views,
  accounts_engaged,likes,comments,shares,saves,follower_count` (verify exact parameter names the
  same way).
- Replace `fetchMediaInsights` in `instagram-publish.ts` (lines 196-214) to call
  `mediaMetricsFor(mediaType)` instead of the inline deprecated strings — this fixes the Part A bug
  in place, and the sync module (3.3) reuses the same function so the on-demand route and the
  scheduled sync never drift apart.

**3.2 Media catalog sync + one-time import.** `server/src/insights/sync.ts`:
- `handleSyncMediaInsights(payload: {media_id, period_label})`: calls `igGet` for
  `mediaMetricsFor(...)`, upserts into `ig_media_metrics`.
- A one-time import function (invoked once per newly-connected account, or via a small CLI script
  mirroring `server/scripts/backfill-scene.ts`'s pattern): paginate
  `GET /{account_id}/media?fields=id,permalink,caption,timestamp,media_type,media_product_type,
  thumbnail_url` and upsert each into `ig_media` with `is_imported = 1` and `post_id = NULL` unless
  a matching `posts.instagram_media_id` already exists (in which case set `post_id` to that post and
  `is_imported = 0`).
- Depends on: Chunk 2 (tables), 3.1 (metric names).

**3.3 Per-post polling scheduler.** In `server/src/insights/scheduler.ts`, a function that: for every
`ig_media` row with a known `timestamp`, computes elapsed time since publish and determines which
of the slots `1h, 6h, 24h, 72h, 7d, 28d, weekly_5..weekly_13` (weekly from day 35 to day 91, i.e.
`weekly_N` for `N = 5..13`, each `N` meaning "the Nth week since publish") are now due and not yet
present in `ig_media_metrics` for that `media_id`+`period_label`. Enqueues
`sync_media_insights` with `dedupe_key = `sync_media_insights:${media_id}:${period_label}``. Stop
checking a post once its elapsed time exceeds 91 days (no more slots will ever become due).
- Depends on: 3.1, 3.2.

**3.4 Account + audience sync.**
- `handleSyncAccountInsights(payload: {account_id, date})`: calls `accountMetricsFields()` against
  the account-insights endpoint for that date, upserts into `ig_account_metrics_daily`; sets
  `final = 1` only once `date` is more than 3 days in the past (Meta's own stated settling window),
  else `final = 0` so later re-syncs of the same date are expected to still change the row.
- `handleSyncAudienceInsights(payload: {account_id})`: first checks the account's current follower
  count (from the most recent `ig_account_metrics_daily` row or a fresh lookup); if `< 100`, no-op
  and record nothing (per F7) rather than enqueueing/erroring. Otherwise fetches demographics and
  inserts a new `ig_audience_snapshots` row.
- The coarse scheduler (`server/src/insights/scheduler.ts`'s tick function) runs on its own interval
  — propose 30 minutes, started alongside but independently of the existing 15s `schedulerTick`
  (add a second `setInterval` next to the existing one in whatever function starts the worker loop,
  `jobs.ts` around line 403+; or add the call inside `startJobWorker` itself gated by a separate
  timer — confirm the exact current start-up wiring at implementation time) — and on each tick:
  - For each connected account: enqueue `sync_account_insights` for `today`, `today-1`, `today-2`
    (three separate dedupe keys, each `` `sync_account_insights:${account}:${date}` ``) — relying on
    `enqueueJob`'s dedupe-key-freed-on-terminal-status behavior (verified in Chunk-3 analysis above)
    to make later-day re-syncs of the same date work automatically.
  - Once a week (gate this by checking whether an `ig_audience_snapshots` row for this account newer
    than 7 days already exists — don't add a second timer for a different cadence): enqueue
    `sync_audience_insights`.
  - For any `instagram_conn` with `token_expires_at` within 10 days: enqueue `refresh_token` (Chunk
    1.4), dedupe key `` `refresh_token:${connection_id}:${date}` ``.
  - Also drive 3.3's per-post polling here, in the same tick.
- Depends on: 3.1, 3.2, 3.3, Chunk 1.4.

**3.5 Rate-limit handling (F12).** In `igGet` (or a thin wrapper used only by the new sync module, to
avoid touching the publish path's existing behavior), catch a 429/rate-limit error shape and rethrow
a distinguishable error; no special backoff logic needs to be added to `jobs.ts` — its existing
3-stage backoff (`BACKOFF_S = [30, 120, 600]`, `jobs.ts:23`) already retries failed jobs, which is
sufficient given these are free, non-urgent jobs.

**Tests (Chunk 3)**
- `mediaMetricsFor`/`accountMetricsFields` return the expected field lists (and do **not** contain
  `impressions` or `plays` — regression-pins the Part A fix).
- `handleSyncMediaInsights`: mocked Graph response upserts the right row; re-running with a
  different mocked value for the *same* `media_id`+`period_label` updates in place (no duplicate
  row) — proves the `UNIQUE` upsert.
- Per-post polling: given a fixture `ig_media` row at various synthetic ages, the scheduler enqueues
  exactly the slots that are due and not yet synced, and enqueues nothing once a post is over 91
  days old.
- `handleSyncAccountInsights`: a date more than 3 days old is marked `final=1`; today's date is
  `final=0`.
- `handleSyncAudienceInsights`: no-ops (no new row, no thrown error) for an account under 100
  followers; inserts a row otherwise (mocked Graph response).
- `refresh_token`/account/audience scheduling: the coarse tick enqueues the right dedupe-keyed jobs
  given a fixture set of connections/accounts, and does not double-enqueue within the same day.

### Chunk 4 — Performance digest + planner/judge integration

**4.1 Digest computation.** `server/src/insights/digest.ts`:
`computePerformanceDigest(brandProfileId): PerformanceDigest | {insufficientData: true}`.
- Join `posts` (for the brand) → `ig_media` (via `instagram_media_id`/`post_id`) →
  `ig_media_metrics` (period `7d`, falling back to the latest available period if `7d` isn't synced
  yet) to compute each post's score: `(saved + 1.5*shares + 3*follows) / reach` (guard divide-by-zero
  reach as `null` score, excluded from ranking).
- Require `count(published posts with a usable score) >= 8`; otherwise return
  `{insufficientData: true, count}` so callers can render "not enough posts yet (N of 8)" instead of
  a misleading digest.
- Compute the brand's 30-post median score as the baseline; top/bottom 5 by score (hook, first
  line, format, pillar — pulled from the `posts` row); lift by `format` and by `pillar` (mean score
  per group vs. overall median).
- Mark the whole digest `correlational: true` in its shape (per the plan's explicit "labeled as
  correlational" requirement) — this is a displayed/consumed flag, not just a comment.

**4.2 BrandContext section.** In `server/src/generation/brand-context.ts`: add `'performance'` to
`ContextSectionName`, a priority entry in `SECTION_PRIORITIES` (low priority — it's supplementary,
should be the first thing dropped under budget, matching `renderHooksMemory`'s treatment), and a
`renderPerformance(ctx)` function that turns the digest (when present and sufficient) into 2-4
sentences of prose (e.g. "Reels have outperformed feed posts by 40% over your last 30 posts; your
top hook was ...") or omits the section entirely when `insufficientData`. Add `'performance'` to the
`sections` array passed to `renderContext` at the plan-step call site (`pipeline.ts:167`) and the
judge call site (`pipeline.ts:462`).

**4.3 Week-plan integration.** In `server/src/skills/week-plan.ts`: add `performanceSummary?: string`
to `planWeekTopics`'s options type, splice it into the prompt built around lines 108-124 (framed as
"what has worked recently," suggesting but not forcing format-mix changes — the plan explicitly
wants "±1 changes... which you accept or not," i.e. a suggestion surfaced in the week-plan output,
not a silent auto-change). In `server/src/skills/fill-week.ts` (lines 70-78), compute the digest via
4.1 and pass its summarized text through to `planWeekTopics`.

- Depends on: Chunk 3 (needs real metrics data to compute anything), Chunk 2 (tables).

**Tests (Chunk 4)**
- `computePerformanceDigest`: fixture with 10 scored posts produces correct top/bottom 5, correct
  median-relative lift by format; fixture with 5 posts returns `insufficientData`; a post with
  `reach = 0` is excluded from scoring, not divide-by-zero-crashed.
- `renderPerformance` omits the section when `insufficientData`, and produces non-empty prose
  otherwise; section is dropped first under a tight budget (reuse the existing `renderContext`
  priority-drop test pattern from `brand-context.test.ts`).
- `fillWeekForBrand`/`planWeekTopics`: passing a `performanceSummary` changes the resulting prompt
  content (string-contains assertion) without changing behavior when omitted (back-compat check).

### Chunk 5 — Shared types + client `/insights` screen + post `Performance` tab

**5.1 Shared types.** `shared/src/insights/types.ts` + `index.ts` barrel (mirroring
`shared/src/scene/`): `PerformanceDigest`, `DigestPost` (hook/first-line/format/pillar/score),
`AccountMetricsDailyRow`, `AudienceSnapshot`, `MediaMetricsRow` — these are the shapes the new server
endpoints (5.2) return and the client (5.3) renders, so client and server share one source of truth
instead of each redefining the shape.

**5.2 New server read endpoints** (`server/src/http/routes/` — add alongside the existing
`instagram-posts.ts`/`budget.ts` routes, don't overload an unrelated router):
- `GET /api/insights/account?account_id=` → recent `ig_account_metrics_daily` rows + latest
  `ig_audience_snapshots` row (or `{hidden: true, reason}` under 100 followers).
- `GET /api/insights/digest?brand_profile_id=` → the Chunk 4 digest (or `{insufficientData, count}`).
- (Per-post performance reuses the **existing** `GET /:id/instagram/insights` /
  `GET /:id/instagram/comments` routes — no new endpoint needed there, per the analysis in §3.)

**5.3 Technical decision: charting library.** No charting library exists in `client/package.json`.
Add **Recharts** (a widely-used, lightweight React charting library) rather than hand-rolling SVG
charts — it composes cleanly with the project's existing CSS-variable design tokens (colors passed
as props, not baked into a separate theme system) and is the lower-effort choice for the stat strip,
followers-per-day line chart, and lift bar charts this screen needs. Whoever implements the actual
chart components should run the `dataviz` skill's guidance for color/axis/legend conventions so the
charts match the app's existing design tokens rather than Recharts' defaults.

**5.4 `/insights` screen.** Replace `client/src/routes/InsightsScreen.tsx` entirely (it's currently a
9-line stub) with, per the plan's F.4 Insights spec:
- A finding line (one sentence, computed from the digest, e.g. "Reels on 'X' brought 61% of new
  follows" — derive from the top digest post's format/lift, not a hardcoded template).
- A stat strip (followers, reach 28d, views 28d, saves-per-reach) with each figure's baseline stated
  in words ("vs prior 28 days") — computed by comparing the last 28 `ig_account_metrics_daily` rows
  to the prior 28.
- A followers-per-day line chart with a 1px marker on each day a post was published (join against
  `ig_media.timestamp`/`posts.instagram_published_at`), thumbnail on hover.
- A post leaderboard (from the digest), each row linking to `/posts/:id`.
- Format/pillar lift as bullet rows; best times (computed from `ig_media.timestamp` vs. engagement,
  or deferred to "insufficient data" if there isn't enough history — see Risks, this one isn't fully
  specified by Meta's API shape and needs implementation-time judgment).
- Audience panel, or the explicit "hidden — fewer than 100 followers" state.
- Honest empty/loading states per F.5 conventions already used elsewhere in the app (reuse the
  existing Skeleton/empty-state patterns rather than inventing new ones — check
  `client/src/components/ui/` for what's already there).

**5.5 Post review `Performance` tab.** In the post-review screen (`client/src/routes/PostScreen.tsx`
— confirm current tab structure at implementation time), add a `Performance` tab visible only when
`post.status === 'published'`, calling the existing `getPostInstagramInsights`/
`getPostInstagramComments` (`api.ts:460-481`) and rendering reach/views/saves/shares/comments/
permalink with a "data delayed up to 48h" note, per F11.

**5.6 Reconnect banner.** Wherever the app currently shows connection status (locate at
implementation time — likely `SetupScreen.tsx`'s `StepInstagram` or a Home/Settings connection
widget), surface Chunk 1.3's `needsReconnect` flag as a dismissible banner explaining which scopes
are missing and linking to the reconnect flow.

- Depends on: Chunks 1-4 for real data; 5.1-5.2 can be scaffolded in parallel with Chunk 3 using
  fixture data, then wired to real endpoints once Chunk 3/4 land.

**Tests (Chunk 5)**
- Server endpoint tests: `/api/insights/account` returns the hidden-audience shape under 100
  followers, real data otherwise; `/api/insights/digest` returns `insufficientData` under 8 posts.
- Client test: `InsightsScreen` renders the stat strip, leaderboard links, and the "not enough posts
  yet" empty state when the digest endpoint returns `insufficientData` (mock the query).
- Client test: the `Performance` tab is absent for a non-published post and present with correct
  data for a published one (mock `getPostInstagramInsights`).
- Client test: the reconnect banner renders when `needsReconnect` is true and is absent otherwise.

## 6. Business rules and edge cases

- A post with `reach = 0` at the 7-day mark is excluded from digest scoring (not a divide-by-zero
  crash, not a score of `Infinity`).
- Digest requires ≥8 published posts with a usable score; fewer than 8 → `insufficientData`, surfaced
  honestly in both the UI and the planner/judge prose (omit the section rather than inventing a
  digest from too little data).
- Audience sync and audience UI panel are both gated on ≥100 followers — this is a real Meta API
  restriction, not just a UI nicety; the sync job must no-op (not retry-loop forever) under the
  threshold.
- `ig_account_metrics_daily.final` distinguishes settled rows from still-adjusting ones; the UI
  should not represent a non-final day's numbers as the final answer (e.g. a subtle "still updating"
  treatment is fine, but don't silently treat it as equal to a final row — exact visual treatment
  left to implementation, but the distinction must be preserved through to the client).
- Per-post polling stops after 91 days — a post that old gets no further job attempts, not an error
  on every scheduler tick.
- `refresh_token` failures must not throw out of the job runner uncaught; they should record
  `last_error` and let the existing retry/backoff handle it, and should not block other
  jobs/connections.
- Rate-limited Graph API responses retry via the job runner's existing backoff; they are not treated
  as permanent failures after one attempt.
- Scopes: a connection made before Phase 4 ships has `granted_scopes = NULL` and must show the
  reconnect banner — don't assume historical connections already have the new scopes.
- Imported (`is_imported = 1`) media rows have `post_id = NULL` and must be handled gracefully by any
  UI that joins `ig_media` → `posts` (e.g. the leaderboard/digest should only use digest scoring for
  posts the agent actually created and that are joinable to a `posts` row with a pillar/format —
  imported media can still count toward the follower-marker timeline on the chart (F10) but not
  necessarily toward pillar/format lift if those fields are unknown for imported posts).
- Daily account sync re-syncs the last 3 days on every run; this is intentional duplication of
  Graph API calls (bounded, free, and necessary for data correctness given Meta's delay) — don't
  "optimize" this away by only syncing `today`.

## 7. Constraints and compatibility

- Do not rename, remove, or change the behavior of `learn`, `fetchMediaInsights`'s call signature
  (only its internal metric-string construction), `igGet`, or the existing on-demand
  `GET /:id/instagram/insights`/`/comments` routes — these stay as-is and Chunk 5.5 reuses them
  unchanged.
- Do not touch `JobKind`'s existing four values' behavior — only add new union members and new
  `case` branches.
- Do not add budget preflight to the new job kinds — they must stay free, per T1.
- Do not change `instagram_conn`'s existing columns — only add `granted_scopes`.
- `posts`/`brand_profiles` schemas are unchanged; the digest derives brand↔account mapping by
  joining through `posts`, not by adding a new FK to `brand_profiles` (avoids assuming a brand maps
  to exactly one IG account, which isn't guaranteed by the current schema).
- MCP exposure of any Phase 4 data (tools/resources) is explicitly Phase 5 scope — do not add MCP
  tools in this plan.
- Phone/responsive layout for `/insights` is not required by this plan (consistent with Phase 2/3's
  deferred phone-layout work being tracked separately) — build the desktop layout correctly; a
  dedicated mobile pass can follow later.
- Changes to `instagram-oauth.ts`'s scope handling touch a security-relevant path (what the app is
  allowed to do on the user's behalf) — flag this change explicitly in review rather than bundling it
  silently into a larger diff.

## 8. Requirement-to-implementation mapping

| Requirement | Implementation | Verification |
|---|---|---|
| F1 — correct, live scopes | Chunk 1.1 | Test: authorize URL reflects env override + new scopes |
| F2 — reconnect detection | Chunk 1.2, 1.3 | Test: `connectionNeedsReconnect` cases |
| F3 — token refresh | Chunk 1.4 | Test: mocked refresh success/failure |
| F4 — media catalog + import | Chunk 3.2 | Test: import upserts, `post_id` join logic |
| F5 — per-post polling, correct metrics | Chunk 3.1, 3.3 | Test: due-slot logic, metric names exclude deprecated fields |
| F6 — daily account sync, 3-day re-sync, `final` flag | Chunk 3.4 | Test: `final` flag by date age |
| F7 — audience sync, 100-follower gate | Chunk 3.4 | Test: no-op under threshold |
| F8 — digest computation | Chunk 4.1 | Test: scoring, median, top/bottom, insufficientData |
| F9 — planner/judge integration | Chunk 4.2, 4.3 | Test: section rendering, prompt-content assertions |
| F10 — `/insights` screen | Chunk 5.3, 5.4 | Client test: all stated sections render / honest empty states |
| F11 — `Performance` tab | Chunk 5.5 | Client test: tab visibility + data rendering |
| F12 — rate-limit backoff | Chunk 3.5 | Relies on existing job-runner backoff (no new test beyond confirming the error shape is retried, not swallowed) |
| T1 — free job kinds | Chunk 3 (all handlers) | Test: preflight branch untouched; new kinds absent from it |
| T2 — actor plumbing | Chunk 3 (`SCHEDULER_ACTOR` on all enqueues) | Test: enqueued job payload/actor columns |
| T3 — migration convention | Chunk 2 | Migration test |
| T4 — reuse `igGet` | Chunk 3.1 | Code review (no new fetch/auth logic) |
| T5 — shared types module | Chunk 5.1 | Typecheck: client/server both import from `shared/src/insights` |

## 9. Acceptance criteria

- Connecting (or reconnecting) Instagram requests `instagram_business_manage_insights` and
  `instagram_business_manage_comments`, verifiable by inspecting the generated authorize URL.
  (Matches Phase 4's OAuth exit requirement.)
- A connection made before this phase shipped shows a reconnect banner; one made/reconnected after
  does not.
- Against mocked Graph responses: a freshly published post accumulates `ig_media_metrics` rows at
  each due slot over simulated time, using `views` (never `impressions`/`plays`).
- Account metrics for the last 3 days update on each daily sync run; metrics older than 3 days are
  marked `final`.
- An account under 100 followers never gets an `ig_audience_snapshots` row and the `/insights`
  audience panel states why.
- With ≥8 published, scored posts, `/insights` shows a real leaderboard and finding line; with fewer,
  it honestly says "not enough posts yet (N of 8)."
- The week-plan prompt changes (verifiable via a content assertion) when a performance digest is
  available, and is unchanged when it isn't — confirming F9 without requiring an LLM call in tests.
- A published post's review page shows a `Performance` tab with real reach/views/saves/shares/
  comments and a 48h-delay note; an unpublished post's review page does not show that tab.
- `pnpm typecheck` and `pnpm test` (server + client) pass; the new `shared/src/insights` module
  typechecks and is consumed by both.

## 10. Testing strategy

- **Unit**: metric-set functions (3.1), digest scoring/median/lift (4.1), due-slot computation
  (3.3), scope/reconnect logic (1.1-1.3), week-plan prompt splicing (4.3) — all pure functions,
  testable without a DB or network, following the existing hermetic-test pattern used for
  `brand-context.test.ts` (temp `DB_PATH` + dynamic import where a module-level DB singleton would
  otherwise collide under parallel vitest workers).
- **Integration (DB)**: migration applies cleanly (Chunk 2); job handlers upsert correctly against a
  real (temp-file) SQLite DB with mocked `fetch`/Graph responses (Chunks 1.4, 3.2-3.4).
- **Job-runner integration**: new job kinds dispatch correctly from `runJob`'s switch; dedupe-key
  behavior across terminal/non-terminal states is exercised directly (reuse the existing
  `jobs.test.ts` fixture/harness pattern).
- **API/route tests**: the two new `GET /api/insights/*` endpoints, and a regression test that the
  two *existing* per-post insights/comments endpoints are unchanged.
- **Client tests**: `InsightsScreen` section rendering and empty states, `Performance` tab
  visibility, reconnect banner — using the project's existing `vi.mock`/`react-konva`-stub-free
  (this screen has no canvas) component-test conventions.
- **Regression**: `fetchMediaInsights`'s call signature is unchanged even though its internal metric
  string changes — existing callers (`instagram-posts.ts:231-254`) must keep working unmodified; add
  a test asserting the returned shape's keys no longer include `impressions`/`plays` but do include
  `views`.
- No new Playwright/E2E test is strictly required by this plan's acceptance criteria, but the
  existing `pnpm test` suites (server vitest, client vitest) must stay green throughout, and
  `pnpm typecheck` across all four packages (shared/server/server-evals/client) must be clean before
  calling any chunk done — matching this project's established verification discipline from prior
  phases.

## 11. Risks and unresolved questions

- **Meta Graph API field names for demographics and some account metrics are not pinned anywhere in
  this repo** and may differ from what's listed in Chunk 3.1/3.4 by the time of implementation —
  verify against Meta's current docs for the app's configured `META_GRAPH_VERSION` before shipping,
  and treat any mismatch as a metric-set bug fix, not a plan deviation.
- **"Best times" (F10)** isn't fully specified by what Meta's API actually exposes (the plan
  references `online_followers`, which may or may not be available for this account's tier/API
  version) — implementer should confirm data availability first and fall back to an honest "not
  enough data" state if the underlying metric isn't accessible, rather than fabricating a
  best-times estimate from insufficient signal.
- **Scheduler timing**: the exact mechanism/interval for starting the existing 15s `schedulerTick`
  (`jobs.ts` around line 403+) wasn't fully traced in this plan's investigation — confirm the exact
  current wiring before adding the second, coarser tick, so the two don't conflict or double-start
  under test/dev vs. production process boundaries (recall this app runs two processes — Express and
  MCP — against one SQLite file; the new tick must only run in the Express worker process, same as
  the existing one).
- **Concurrent repo changes**: during this plan's investigation, several items from the separate
  `docs/phase2-phase3-fixes-plan.md` (restart-archiving, Studio AI-action stubs, re-roll limit
  enforcement) were found to already be implemented in the working tree, despite not having been
  built in this conversation — indicating another process or session may be actively editing this
  same repository concurrently. Before starting Phase 4 implementation, re-check
  `docs/phase-tracker.md` and the fixes-plan chunks against current code, since this plan's own
  citations could similarly drift if implementation doesn't start immediately.
- **Brand↔account mapping ambiguity**: the schema doesn't enforce one IG account per brand; this plan
  assumes the common case (one account) and derives it via `posts`/`default_brand_profile_id`. If a
  brand genuinely spans multiple connected accounts, the digest/insights screen's account-selection
  logic needs explicit design before implementation — flagged here rather than silently picking one
  account.
- **Historical import volume**: F4's one-time import of pre-existing posts has no stated pagination
  limit in the plan; implement with Graph API's standard cursor pagination and no artificial cap,
  but be aware a long-lived account could have hundreds of posts — the import job should use the
  same lease-renewal pattern as other long-running jobs (`setInterval` lease heartbeat) rather than
  risking a lease timeout on a single long `fetch` loop.
