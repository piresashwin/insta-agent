# Instagram AI Content Agent — Full System Plan

> A plan for an autonomous AI agent that plans, drafts, generates assets for, and publishes Instagram content — with human-in-the-loop approvals, a React dashboard, a Hermes- orchestrator, and free-media sourcing.

---

## 1. Executive Summary

The system is a content producer pipeline for Instagram. A **Hermes agent** (powered by skills) does the creative work — planning topics, writing hooks/captions, generating image/reel prompts, reviewing outputs — while a **backend orchestrator** owns persistent state, the approval queue, and the Instagram publishing interface. A **React dashboard** gives the human operator a single place to connect Instagram, review pending posts, iterate on drafts, and track what the agent has produced.

High-level data flow per post:

```
content planner  →  Hermes agent crafts draft   →  approval queue  →  user approves/iterates
        ↓                                              ↓
image/reel prompt  →  free media fetch/generation   →  upload to Instagram  →  published
```

---

## 2. Goals & Non-Goals

### Goals
- **Automated content production** — the agent produces a complete, publishable post (concept + caption + visual) from a simple topic or prompt.
- **Human-in-the-loop approval** — every post requires reviewer sign-off, with an iterate-on-request loop (multiple drafts before publishing).
- **Single management surface** — a React dashboard to connect Instagram, approve posts, view assets, and monitor status.
- **Free-media-first** — images and reels come from free sources (or free generation), so recurring cost stays at zero.
- **Skills-driven** — content, caption, image/reel, and review capabilities are packaged as reusable Hermes skills.

### Non-Goals (v1)
- Live social scheduling for *other* platforms (only Instagram).
- Advanced analytics/ads manager (monitoring only in v1).
- Generative video from text (e.g., Runway/DALL-E video) — use free stock video + short clips from free sources; AI image generation optional.
- Multi-account orchestration (single Instagram business account, pluggable for more later).

---

## 3. System Architecture

```
┌────────────────────────────────────────────────────────────┐
│  React Dashboard (localhost / LAN / hosted)                │
│  • Instagram connect (App ID, Client Secret, OAuth)        │
│  • Content calendar, post queue, post detail, asset gallery│
│  • Approval interface (comments, iterations)               │
└────────────────────────┬───────────────────────────────────┘
                         │  REST API (HTTPS)
┌────────────────────────▼───────────────────────────────────┐
│  Backend Orchestrator (FastAPI / Express)                  │
│  • Post CRUD + status workflow                             │
│  • Approval & iteration state machine                      │
│  • HTTP bridge to Hermes agent                             │
│  • Instagram Graph API client (token mgmt)                 │
│  • Asset/link storage                                      │
└──────┬──────────────────────────────┬──────────────────────┘
       │  tool calls / websocket                │  tool calls
┌──────▼──────────────────────────────▼──────────────────────┐
│  Hermes Agent (spawned process / background)                 │
│  • Loads skills: content-planning, caption-writing,        │
│    image-reel-generation, post-review                      │
│  • Uses Hermes tools: terminal, web_search, browser_navigate│
│  • Returns structured post JSON to orchestrator             │
└──────┬──────────────────────────────┬──────────────────────┘
       │  queries                                 │  publishes
┌──────▼──────────────────────────────▼──────────────────────┐
│  Free Media Sources                                          │
│  • Images: Pexels, Unsplash, Pixabay (free tier APIs)      │
│  • Video: Coverr, Mixkit, Pexels Video                     │
│  • Optional generation: local Stable Diffusion (if available)│
└──────────────────────────────────────────────────────────────┘
```

### Deployment model
- **V1 local-first:** everything runs on the user's machine (GitHub Codespace, Docker, or a local server). The dashboard is reachable at `http://localhost:3000` (or the LAN IP).
- **Orchestrator ↔ Hermes:** the orchestrator spawns a Hermes subprocess with a bounded timeout, passes the post prompt/context, and reads the structured JSON reply. A WebSocket option is available if they want live agent progress in the UI.

---

## 4. Component Breakdown

### 4.1 React Dashboard
Single-page app (create-vite + React + TS) with:

- **Instagram setup page** — form fields: `App ID`, `Client Secret`, `Redirect URI` (OAuth). On save, generates the Meta app manifest/OAuth link and stores credentials (encrypted at rest). Proceeds through the consent screen and token exchange.
- **Content calendar** — month/week/day grid of upcoming posts, color-coded by status.
- **Post queue** — table of draft → pending approval → approved → published, with filters, search, and bulk actions.
- **Post detail / approval view** — renders the full draft (hook, caption, hashtags, image/reel prompt, proposed asset), an approval button, a comment box for change requests, and an iteration counter.
- **Asset gallery** — preview of generated images/reels with download links, media file storage view.
- **Settings** — skills toggles, broker timeout, default content style/brand voice.

### 4.2 Backend Orchestrator
Owns state and the "source of truth." Responsibilities:
- CRUD for `Post` resources and their lifecycle (below).
- Approval + iteration state machine (validating transitions, e.g., you cannot publish an unapproved post).
- Storing credentials securely (env var + encrypted local storage; never in source control).
- Bridging to the Hermes agent (spawn + timeout + JSON parse).
- Mediating Instagram upload requests and token refreshes.
- Webhook/error handling: if agent fails or times out, the post returns to `needs_revision` with an error note.

### 4.3 Hermes Agent
The creative engine. It is a normal Hermes instance that:
- Loads the four content skills (see §5).
- Runs one "post production" routine per post: plan → draft → generate/receive asset prompt → review → return JSON.
- Never directly touches Instagram; it produces prompts and text. The orchestrator handles delivery.

### 4.4 Skills Suite (Hermes skills)
Four skills, authored per the `hermes-agent-skill-authoring` standards:

| Skill | Purpose |
|---|---|
| `content-planning` | Turn a topic/seed into a full concept: target audience, hook, angle, format (reel/feed), tone, hashtag themes, 3 alternate hooks. |
| `caption-writing` | Write the caption + emojis + CTA, matching brand voice, with a teaser/first-line emphasis for social scannability. |
| `image-reel-generation` | Convert the post into concrete image/reel prompts; query free sources; select/prepare the best match; produce the image or short reel. |
| `post-review` | Critique the draft against brand voice, hook strength, caption quality, and post quality; return concrete revision suggestions. |

### 4.5 Instagram Integration
- **Auth:** Meta "Log in with Instagram" OAuth (client-side app). The backend stores `App ID` + `Client Secret` + `Redirect URI` from the dashboard.
- **Graph API paths:** `/{userID}/media` (upload photo or reel), `/{userID}/media/{mediaId}/publish` (publish), `/{userID}/media/{mediaId}` (query/status/cancel).
- **Tokens:** short-lived → long-lived exchange; refresh as needed; persist the long-lived token + `account_id`.
- **Rate-limit awareness:** the orchestrator queues upload requests and handles `429` with backoff; the dashboard shows upload status.
- **Approval gate:** the orchestrator never publishes until `status == "approved"`.

### 4.6 Free Image/Video Sources & Generation
- **Free image APIs:** Pexels, Unsplash, Pixabay — each has generous free tiers / no-key options. The skill queries them, filters by the post's theme, and picks the best (relevance, aspect ratio, quality).
- **OpenAI GPT Image 2** (`gpt-image-2` / DALL-E 3 via OpenAI API) as an **optional generated** image — paid, pay-per-image. Added on user request.
- **Local Stable Diffusion** (optional, if a GPU is available) as a third fallback/overlay. Default v1 = free sources; GPT Image 2 only on request.
- **Video:** Coverr, Mixkit, Pexels video — matched to the reel concept.
- **Aspect ratios:** 9:16 for reels, 4:5 or 1:1 for feed; the agent requests source assets in the right ratio.

---

## 5. Data Model

```sql
-- Connection
CREATE TABLE instagram_conn (
  id INTEGER PRIMARY KEY,
  app_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,          -- encrypted at rest
  redirect_uri TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  account_id TEXT,
  status TEXT NOT NULL,                 -- connected / disconnected
  created_at TEXT,
  updated_at TEXT
);

-- Posts
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,                 -- draft | pending_approval | in_review | changes_requested | approved | media_generating | media_ready | pending_upload | publishing | published | failed
  topic TEXT,                           -- original user/planner seed
  hook TEXT,                            -- final hook
  caption TEXT,
  hashtags TEXT,
  image_prompt TEXT,
  reel_prompt TEXT,
  image_url TEXT,
  reel_url TEXT,
  media_type TEXT,                      -- image | reel
  instagram_media_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  revisions INTEGER DEFAULT 0,
  revision_comments TEXT,               -- array of {author, comment, at}
  agent_output TEXT,                    -- raw JSON from Hermes
  error TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Approvals / iterations
CREATE TABLE iterations (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  author TEXT NOT NULL,
  comment TEXT NOT NULL,
  created_at TEXT
);

-- Agent skill usage log (optional, for review)
CREATE TABLE skill_runs (
  id INTEGER PRIMARY KEY,
  post_id INTEGER,
  skill TEXT NOT NULL,
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  created_at TEXT
);
```

Post status transitions require the orchestrator to validate each move (enforced by the API, not the UI).

---

## 6. Post Lifecycle & Approval/Iteration Workflow

```
draft
  → content planner + Hermes draft
  → pending_approval
        ↓  (reviewer opens detail in UI)
     ── approve ──→ approved → media_generating → media_ready → pending_upload → publishing → published
        ↓
     changes_requested ← revolver adds a revision with comment
        ↓
     agent re-drafts (revisions++)
     → back to pending_approval
        ↓
     reviewer approves again → publish
```

### Key rules
- **Every post is reviewed** before any asset is generated or anything is published. No exceptions.
- **Iterations are first-class.** Each `changes_requested` event stores a comment and bumps `revisions`; the reporter sees the full comment history in the detail view.
- **The agent cannot publish.** It produces text + asset prompts only. Delivery is always by the orchestrator, which enforces the `approved` gate.
- **Timeout guard.** If the agent exceeds a configurable bound, the post returns to `needs_revision` with an error; the reviewer rewrites and retries.
- **Saved drafts.** A post can be abandoned mid-way without publishing (no auto-transition).

---

## 7. Skill Specifications

### 7.1 content-planning
**Trigger:** input = seed topic/keyword + optional audience/angle.
**Produces:** `topic`, `audience`, `hook` (one line), `angle`, `format` (reel/feed/carousel), `tone`, `hashtag_theme`, `alt_hooks` (list of 3).
**Constraints:** every post must end with a single, strong hook; no empty angles; hooks must be 1–2 sentences.

### 7.2 caption-writing
**Trigger:** input = `hook`, `angle`, `format`, `brand_voice`, `target_audience`.
**Produces:** `caption` (with line breaks and strategic emojis), `cta`, `hashtags` (curated), `first_line` (first 2 lines for the profile preview).
**Constraints:** caption + CTA must fit Instagram's 2,200-char limit; first line must hook mid-scroll.

### 7.3 image-reel-generation
**Trigger:** input = post concept + chosen `format` + free-source config + generation source config.
**Produces:** `image_prompt`, `reel_prompt`, `image_url` (or `reel_url`), `media_type`, plus a fallback prompt if the primary source fails.
**Constraints:** prefer free sources; never expose API keys; if a source fails, try the next and return the error in `agent_output` for the reviewer.

### 7.4 post-review
**Trigger:** input = full post draft + brand voice.
**Produces:** `score` (0–10), `issues` (list of concrete problems), `suggestions` (list of actionable rewrites), `approved` (bool) if score ≥ threshold.
**Constraints:** never silently auto-approves; always returns human-readable issues.

---

## 8. API Design (REST)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/posts` | Create a draft post (topic + brand options + agent settings). |
| `GET` | `/api/posts` | List posts (filters: status, topic, date range). |
| `GET` | `/api/posts/:id` | Full detail incl. revisions. |
| `PATCH` | `/api/posts/:id` | Update topic/settings (only in `draft` or `changes_requested`). |
| `POST` | `/api/posts/:id/approve` | Approve; sets `approved`, captures `approved_by`. |
| `POST` | `/api/posts/:id/request-changes` | Open a revision with comment; sets `changes_requested`. |
| `POST` | `/api/posts/:id/agent-run` | Ask Hermes to run/revise (enqueues, doesn't wait). |
| `GET` | `/api/posts/:id/status` | Watch status (SSE optional). |
| `POST` | `/api/posts/:id/publish` | Trigger asset generation → upload → publish. |
| `GET` | `/api/admin/instagram` | Connection form (GET) + save (POST). |
| `GET/POST` | `/api/admin/instagram/oauth` | Initiate / callback OAuth. |
| `POST` | `/api/assets/:id/download` | Serve the generated image/reel. |

All writes validate status transitions. The orchestrator is the only writer for status changes; the UI is read-mostly + approval gates.

---

## 9. Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript + Vite; lightweight UI kit (shadcn/ui or Mantine); no heavy build step required for v1 |
| Backend | Node.js + Express (orchestrator + REST API); spawns Hermes subprocess |
| Agent | Hermes (spawned process via `hermes chat -q` one-shot or tmux for interactive) |
| DB | Node built-in node:sqlite (local SQLite) → PostgreSQL (later) |
| Auth/OAuth | Meta Graph API OAuth (client-side redirect + backend token exchange) |
| Media storage | Local disk (v1) → S3/minIO (later); served via signed URL |
| Skills | In-repo Hermes skills under `skills/` |
| Infra | Docker (local v1): Express + Node + SQLite in one container; React dev volume |

---

## Multi-Account Instagram Setup (new)
Multiple Instagram Business accounts are supported natively: each account is a row in `instagram_conn`
with its own `account_id`, tokens, and `app_id`/`client_secret`. Changes in v1:

- **Connection selector** in the UI — a dropdown to pick the active account; connect/disconnect per account.
- **Per-post account binding** — each post stores `account_id` (nullable; defaults to the active account).
- **Per-account routing** — the orchestrator routes `publish`, `add_comments`, `like` calls to the account that owns the post.
- **Single OAuth consent** per account; the consent screen is initiated with the selected account's `redirect_uri`.

## 10. Implementation Phases

### Phase 1 — Skeleton + Instagram connect (2–3 days)
- React scaffold + router + layout.
- Express backend skeleton + SQLite + the `posts` + `instagram_conn` tables.
- OAuth flow: save App ID/Client Secret, redirect to consent, exchange token, store tokens, connect/disconnect button.
- **Demo:** dashboard connects to an actual Instagram Business account.

### Phase 2 — Post lifecycle + approvals (3 days)
- Status machine + API validation; `draft` → `pending_approval` → `approved` → publish.
- Approval UI + revision comments + iteration counter.
- **Demo:** create a post, get an approval, request a change, re-approve, publish.

### Phase 3 — Hermes + skills (3–4 days)
- Spawn a Hermes subprocess from the orchestrator; pass the post draft; parse the JSON reply.
- `content-planning`, `caption-writing`, `image-reel-generation`, `post-review` skills author.
- **Demo:** agent produces a full post concept + captions + asset prompts from a single topic.

### Phase 4 — Free media + generation (3 days)
- `image-reel-generation` skill: query Pexels/Unsplash/Pixabay, pick best match, download, store; short free-video fallback.
- Failover + per-item error handling.
- **Demo:** a post produces a real image (Pexels) or short clip with no cost.

### Phase 5 — Polish (+ v1 wrap)
- Asset gallery, calendar, status watch, settings.
- Rate-limit aware uploads to Graph API.
- Documentation (README, skill docs, architecture update).

---

## 11. Open Questions / Decisions Needed

1. **Max revisions (resolved and configurable)** — default **3 edits per post** before the post goes to `needs_revision`. Change in `config/app.json`.
2. **Branding/knowledge transfer** — see §12 below (brand config + guide + performance memory).

---

## 12. Transferring Brand & Goal Knowledge to the Agent

The Hermes agent is a separate process and cannot "remember" the brand across sessions unless it is
given the knowledge at task time. Recommended: a 4-layer, file-based knowledge system (cheap, reviewable, survives reboots):

| Layer | Artifacts | Populated by |
|---|---|---|
| **Brand config** | `config/brand.json` + `.env` (keys) | UI "Brand" page; saves tone/audience/goals |
| **Brand guide** | `content/BRAND.md` | Operator writes (voice, do/don't, tone examples) |
| **Skill context** | injected into every skill prompt at call time | orchestrator merges guide + config into each agent run |
| **Performance memory** | `learn/posts.json` (engagement-tagged past posts) | logged after publish; planner queries for "what worked" |

### How it flows
1. Operator sets brand goals, audience, tone, hashtag style in the UI `Settings → Brand` page. These write
   `config/brand.json` + `.env`.
2. The orchestrator reads `content/BRAND.md` and `config/brand.json` before each agent run and appends them
   to the agent's system prompt / task context.
3. After every publish, the orchestrator logs `post_id`, `engagement`, `hook`, `caption`, `icon` into
   `learn/posts.json`; the `content-planning` skill queries this file to prefer patterns that performed well.
4. If the agent's drafts drift from voice, the operator edits `content/BRAND.md` and the next run picks it up.

### Required content in `content/BRAND.md`
- **Goals** — e.g., grow profile visits, drive saves, sell a product, announce events.
- **Audience** — who they are, where they hang out, what they care about.
- **Voice & tone** — 3 adjectives + "do/say" vs "avoid/say" tables.
- **Format rules** — reel vs feed, aspect ratios, hook formula, caption length, emoji policy.
- **Hashtag style** — how many, mix of niche + broad, where to place.
- **Examples** — 3 good + 3 bad post drafts to calibrate the reviewer skill.

This replaces any "training" and keeps the agent aligned with live operator intent.

