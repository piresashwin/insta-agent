/**
 * Entry-picker smoke test — mounts the real StudioScreen in its 'entry' mode,
 * which never renders the Konva Stage (that only mounts once a post/scene is
 * loaded), so this is safe under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { StudioScreen } from './StudioScreen'

const { navigateMock, createPostMock, studioActionMock, agentRunMock, getRunMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  createPostMock: vi.fn(async (topic: string) => ({
    post: { id: 42, topic, format: 'feed' },
  })),
  studioActionMock: vi.fn(async () => ({
    action: 'auto-layout',
    costLabel: 'local · $0',
    scene_json: JSON.stringify({ version: 2, format: 'feed', size: { w: 1080, h: 1350 }, tokens: { colors: {}, fonts: {} }, pages: [{ id: 'p1', background: { kind: 'color', color: '#111' }, layers: [] }] }),
  })),
  agentRunMock: vi.fn(async () => ({ post: { id: 42 }, run_id: 7 })),
  getRunMock: vi.fn(async () => ({
    run: { id: 7, status: 'running', post_id: 42, goal: '', kind: 'agent_run', model: null, error: null, started_at: '', finished_at: null },
    events: [],
  })),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}))

vi.mock('../api', () => ({
  getPost: vi.fn(),
  getPostScene: vi.fn(),
  savePostScene: vi.fn(async () => ({})),
  createPost: createPostMock,
  listBrandProfiles: vi.fn(async () => ({ brands: [] })),
  studioAction: studioActionMock,
  agentRun: agentRunMock,
  getRun: getRunMock,
  getJob: vi.fn(async () => ({
    job: { id: 1, kind: 'generate_media', status: 'done', post_id: 42, run_id: null, error: null, created_at: '', updated_at: null },
  })),
  getBudget: vi.fn(async () => ({
    cap: 10,
    spent: 0,
    forecast: 0,
    remaining: 10,
    pct_used: 0,
    by_kind: {},
    at_capacity: false,
  })),
}))

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('StudioScreen entry picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows all three entry tabs', () => {
    wrap(<StudioScreen />)
    expect(screen.getByTestId('entry-tab-start')).toBeInTheDocument()
    expect(screen.getByTestId('entry-tab-brief')).toBeInTheDocument()
    expect(screen.getByTestId('entry-tab-fully-ai')).toBeInTheDocument()
  })

  it('building from a brief creates a post and calls the auto-layout studio action', async () => {
    wrap(<StudioScreen />)
    fireEvent.click(screen.getByTestId('entry-tab-brief'))
    fireEvent.change(screen.getByTestId('brief-input'), { target: { value: 'Grind finer if it tastes sour' } })
    fireEvent.click(screen.getByText('Build from brief'))

    await waitFor(() => expect(createPostMock).toHaveBeenCalled())
    await waitFor(() => expect(studioActionMock).toHaveBeenCalledWith(42, 'auto-layout', { text: 'Grind finer if it tastes sour' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/studio/$postId', params: { postId: '42' } }))
  })

  it('running fully AI creates a post, enqueues an agent run, and shows the generating screen', async () => {
    wrap(<StudioScreen />)
    fireEvent.click(screen.getByTestId('entry-tab-fully-ai'))
    fireEvent.change(screen.getByTestId('fully-ai-input'), { target: { value: 'Why cold brew tastes different in winter' } })
    fireEvent.click(screen.getByText('Run fully AI'))

    await waitFor(() => expect(createPostMock).toHaveBeenCalled())
    await waitFor(() => expect(agentRunMock).toHaveBeenCalledWith(42))
    await waitFor(() => expect(screen.getByTestId('generating-screen')).toBeInTheDocument())
  })
})
