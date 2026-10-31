# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo operators and small content teams drafting Instagram posts with a local LM Studio model. They sit at a desk, review machine-written hooks/captions, approve or request changes, and later publish. Primary job on this surface: triage the post queue and decide approve / revise / regenerate.

## Product Purpose

Plan, draft, and stage Instagram content through a skill pipeline (plan → caption → media prompts → review), with durable agent runs and human approval before anything publishes. Success: an operator can create a topic, run the agent, inspect the draft and run timeline, then approve — without leaving the dashboard.

## Positioning

Cognition (local OpenAI-compatible model + LangChain skills) is separated from authority (operator approve / request-changes). The dashboard is the HITL control surface for that split, not a generic social scheduler.

## Operating Context

Monorepo: React/Vite client + Express/SQLite server. Dev: Vite on :5173 proxied to API :3001. LM Studio must be running for agent-run. Week-1 scope: posts, agent-run, approve, request-changes, runs timeline, Instagram connection list (OAuth later). Publish is stubbed.

## Capabilities and Constraints

- Live API: posts CRUD lifecycle, agent-run with `run_id`, approve, request-changes, runs + events, Instagram admin list
- No real Meta Graph publish yet
- Operator identity is local-dev stub until auth chapter
- Agent-run can take 30–60s; UI must show generating state

## Brand Commitments

Product name: Instagram Content Agent (working title). No locked visual brand assets yet.

## Evidence on Hand

- Working API and SQLite-backed posts/runs
- Dashboard wired to `client/src/api.ts`
- No marketing copy, customer logos, or real Instagram account gallery required for Week 1

## Product Principles

1. Operator trust over spectacle — show real draft fields and run events, not vanity metrics.
2. Approval is the product moment — pending drafts and decisions stay one click away.
3. Honest states — empty queues, failed agent runs, and stub publish are labeled as such.
4. Local-first cognition — the UI never pretends the model is online when it is not.

## Accessibility & Inclusion

Keyboard-reachable controls and readable contrast on the operator surface; no product-specific WCAG level locked yet.
