/**
 * Phase 2 — attribution for versions / approvals / runs / jobs.
 * Maps policy/dashboard actors onto the actor_* columns.
 */
export type HistoryActorKind = 'human' | 'mcp' | 'scheduler' | 'agent'

export type HistoryActor = {
  kind: HistoryActorKind
  name: string
  client?: string | null
  id?: string | null
}

export const SCHEDULER_ACTOR: HistoryActor = {
  kind: 'scheduler',
  name: 'scheduler',
  id: 'scheduler',
}

export const AGENT_HISTORY_ACTOR: HistoryActor = {
  kind: 'agent',
  name: 'content-pipeline',
  id: 'agent:pipeline',
}

/** Convert a REST/MCP body actor or PolicyActor-like object into HistoryActor. */
export function historyActorFrom(input?: {
  id?: string | null
  name?: string | null
  role?: string | null
  kind?: string | null
  client?: string | null
  clientInfo?: { name?: string } | null
} | null): HistoryActor {
  if (!input) {
    return { kind: 'human', name: 'unknown', id: null }
  }
  const id = input.id ?? null
  const name = input.name || input.clientInfo?.name || id || 'unknown'
  const client = input.client ?? input.clientInfo?.name ?? null

  if (input.kind === 'scheduler' || id === 'scheduler') return SCHEDULER_ACTOR
  if (input.kind === 'agent' || input.role === 'agent' || id?.startsWith('agent:')) {
    return { kind: 'agent', name, id, client }
  }
  if (
    input.kind === 'mcp' ||
    id?.startsWith('mcp:') ||
    input.role === 'operator_agent'
  ) {
    return { kind: 'mcp', name, id, client }
  }
  return { kind: 'human', name, id, client }
}

export function actorColumns(actor: HistoryActor): {
  actor_kind: string
  actor_name: string
  actor_client: string | null
} {
  return {
    actor_kind: actor.kind,
    actor_name: actor.name,
    actor_client: actor.client ?? null,
  }
}
