# Product

## Platform

Web (desktop-first, mobile-readable)

## Users

Solo operators and small content teams building an Instagram page for a niche.
They sit at a desk to review and approve; they check the inbox from a phone.
Primary job: triage the post queue (approve / revise / regenerate) and monitor performance.

## Product purpose

Plan, draft, and stage Instagram content through a skill pipeline
(research → plan → caption → media → review), with durable jobs, human approval,
and direct publishing. Success: an operator — or an MCP agent acting on their behalf —
can bootstrap a niche page, run the pipeline, review the draft, and publish,
all from one surface.

## Positioning

Cognition (LLM skills via Runware) is separated from authority (human approve / publish).
The dashboard is the HITL control surface for that split, not a generic social scheduler.
MCP tools are a thin adapter over the same API, so external agents get identical guarantees.

## Routes

| Route | Screen |
|---|---|
| `/inbox` | Review queue (default) |
| `/posts/:id` | Post review (copy, media, performance) |
| `/calendar` | Weekly grid with proposals |
| `/studio/new` · `/studio/:id` | Creative studio (Phase 3) |
| `/insights` | Account and post performance (Phase 4) |
| `/brands/:id` | Brand profile editor |
| `/activity` | Actor-attributed event feed (Phase 2) |
| `/settings` | Accounts · Models · Budget · Advanced |
| `/setup` | Onboarding checklist |

## Capabilities

- Posts CRUD, full lifecycle (draft → Needs OK → approved → media → staged → live)
- Agent pipeline runs with durable jobs and SSE events
- Human approve / request-changes with auto-save before action
- Brand profiles with voice, visual identity and rubric
- Calendar with week proposals
- Instagram OAuth and publishing
- Budget tracking (`spend_ledger`) and `/api/health`
- MCP server (stdio) exposing the same API surface

## Technical constraints

- Local-first: stdio MCP, SQLite (`DB_PATH`), single operator
- LLMs via Runware (default) — writer Claude Sonnet 5.5, judge Gemini 3.8 Flash
- Images via Runware imageInference (Seedream 5.0 Flash default)
- Reels: keyframe image approval → image-to-video (Phase 2)
- Budget: $10/month cap enforced from Phase 2; spend tracked from Phase 0

## Product principles

1. **Operator trust over spectacle** — real draft fields and run events, not vanity metrics.
2. **Approval is the product moment** — pending drafts stay one click away; auto-save before every approval action.
3. **Honest states** — empty queues, failed runs, and stubs are labeled as such.
4. **Budget transparency** — every AI action shows its cost; a cap stops silent overspend.
5. **Local-first cognition** — the UI never pretends a model is online when it isn't.

## Accessibility

Keyboard-reachable controls, visible focus rings, Radix focus traps on dialogs.
Contrast ≥4.5:1 for text, ≥3:1 for field outlines. Zero serious axe violations (target, Phase 5).
