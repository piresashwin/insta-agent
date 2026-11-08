/**
 * Studio AI generate-background busy/poll flow (jsdom — Konva stubbed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { StudioScreen } from './StudioScreen'

const studioActionMock = vi.fn()
const getJobMock = vi.fn()

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
  studioAction: (...args: unknown[]) => studioActionMock(...args),
  agentRun: vi.fn(),
  getRun: vi.fn(),
  getJob: (...args: unknown[]) => getJobMock(...args),
  getBudget: vi.fn(async () => ({
    cap: 10,
    spent: 1,
    forecast: 2,
    remaining: 9,
    pct_used: 10,
    by_kind: {},
    at_capacity: false,
  })),
}))

vi.mock('react-konva', () => ({
  Stage: ({ children }: { children?: React.ReactNode }) => <div data-testid="stage">{children}</div>,
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

describe('StudioScreen generate-background', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    studioActionMock.mockResolvedValue({
      action: 'generate-background',
      costLabel: '~$0.02',
      job_id: 99,
    })
    getJobMock.mockResolvedValue({
      job: {
        id: 99,
        status: 'done',
        kind: 'generate_media',
        error: null,
        result: {
          action: 'generate-background',
          costLabel: '~$0.02',
          assets: [{ url: 'https://cdn.example/bg.png', sha256: 'abc', prompt: 'p' }],
          scene_json: JSON.stringify({
            version: 2,
            format: 'feed',
            size: { w: 1080, h: 1350 },
            tokens: { colors: {}, fonts: {} },
            pages: [
              {
                id: 'p1',
                background: {
                  kind: 'image',
                  assetId: 'https://cdn.example/bg.png',
                  fit: 'cover',
                },
                layers: [],
              },
            ],
          }),
        },
      },
    })
  })

  it('polls the job and stays busy until a real image result arrives', async () => {
    wrap(<StudioScreen />)

    await waitFor(() => expect(screen.getByTitle('AI')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('AI'))

    const genBtn = await screen.findByTestId('studio-ai-generate-background')
    fireEvent.click(genBtn)

    await waitFor(() =>
      expect(studioActionMock).toHaveBeenCalledWith(11, 'generate-background'),
    )

    expect(screen.getByText(/Generating/i)).toBeInTheDocument()

    await waitFor(() => expect(getJobMock).toHaveBeenCalledWith(99))
    await waitFor(() =>
      expect(screen.queryByText(/Generating/i)).not.toBeInTheDocument(),
    )
  })
})
