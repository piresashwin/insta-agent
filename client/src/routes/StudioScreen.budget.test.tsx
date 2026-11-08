import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { StudioScreen } from './StudioScreen'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ postId: '11' }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}))

vi.mock('../api', () => ({
  getPost: vi.fn(async () => ({
    post: { id: 11, format: 'feed', brand_profile_id: null, status: 'draft', topic: 't' },
    slides: [],
  })),
  getPostScene: vi.fn(async () => ({
    scene_json: JSON.stringify({
      version: 2,
      format: 'feed',
      size: { w: 1080, h: 1350 },
      tokens: { colors: {}, fonts: {} },
      pages: [{ id: 'p1', background: { kind: 'color', color: '#111' }, layers: [] }],
    }),
    canvas_json: null,
    format: 'feed',
  })),
  savePostScene: vi.fn(async () => ({ ok: true })),
  createPost: vi.fn(),
  listBrandProfiles: vi.fn(async () => ({ brands: [] })),
  studioAction: vi.fn(),
  agentRun: vi.fn(),
  getRun: vi.fn(),
  getJob: vi.fn(),
  getBudget: vi.fn(async () => ({
    cap: 10,
    spent: 10,
    forecast: 10,
    remaining: 0,
    pct_used: 100,
    by_kind: {},
    at_capacity: true,
  })),
}))

vi.mock('react-konva', () => ({
  Stage: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Layer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: () => null,
  Rect: () => null,
  Ellipse: () => null,
  Transformer: () => null,
  Image: () => null,
  Line: () => null,
}))

vi.mock('konva', () => ({}))

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('StudioScreen budget gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('disables paid AI actions with an over-budget reason', async () => {
    wrap(<StudioScreen />)
    await waitFor(() => expect(screen.getByTitle('AI')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('AI'))

    await waitFor(() =>
      expect(screen.getByTestId('studio-budget-block')).toHaveTextContent(/budget cap/i),
    )
    const gen = await screen.findByTestId('studio-ai-generate-background')
    expect(gen).toBeDisabled()
    expect(gen).toHaveAttribute('title', expect.stringMatching(/budget/i))

    const free = screen.getByTestId('studio-ai-auto-layout')
    expect(free).not.toBeDisabled()
  })
})
