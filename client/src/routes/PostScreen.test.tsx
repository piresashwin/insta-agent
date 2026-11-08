import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { PostScreen } from './PostScreen'

const approvePostMock = vi.fn()
const approveMediaMock = vi.fn()
const getPostMock = vi.fn()
const getInsightsMock = vi.fn()
const getCommentsMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ postId: '9' }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../api', () => ({
  approvePost: (...args: unknown[]) => approvePostMock(...args),
  approveMedia: (...args: unknown[]) => approveMediaMock(...args),
  getPost: (...args: unknown[]) => getPostMock(...args),
  listIterations: vi.fn(async () => ({ iterations: [], revisions: 0, max_revisions: 5 })),
  patchPost: vi.fn(),
  requestChanges: vi.fn(),
  listInstagramConnections: vi.fn(async () => ({ connections: [] })),
  getPostReview: vi.fn(async () => ({ review: null })),
  listPostVersions: vi.fn(async () => ({ versions: [], proposed: [] })),
  diffPostVersions: vi.fn(),
  listJobs: vi.fn(async () => ({ jobs: [] })),
  getJob: vi.fn(),
  getRun: vi.fn(),
  getPostInstagramInsights: (...args: unknown[]) => getInsightsMock(...args),
  getPostInstagramComments: (...args: unknown[]) => getCommentsMock(...args),
  agentRun: vi.fn(),
  generateMedia: vi.fn(),
  restartPost: vi.fn(),
  studioAction: vi.fn(),
  estimateCost: vi.fn(async () => ({ estimate: 0.05, spent: 0, cap: 10, would_exceed: false })),
  getIdea: vi.fn(),
  updateIdea: vi.fn(),
}))

vi.mock('../components/InstagramPostPreview', () => ({
  InstagramPostPreview: () => <div data-testid="preview" />,
}))

describe('PostScreen media_ready HITL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPostMock.mockResolvedValue({
      post: {
        id: 9,
        status: 'media_ready',
        format: 'feed',
        topic: 'Test post',
        hook: 'Hook',
        caption: 'Caption',
        hashtags: '',
        agent_output: null,
        error: null,
        image_url: 'https://cdn.example/a.png',
        reel_url: null,
        account_id: null,
      },
      slides: [],
    })
    approveMediaMock.mockResolvedValue({
      post: { id: 9, status: 'staged', format: 'feed', topic: 'Test post' },
      slides: [],
    })
  })

  it('shows Approve media (not copy Approve) and calls approveMedia', async () => {
    render(<PostScreen inlinePostId={9} />)

    const btn = await screen.findByTestId('approve-media')
    expect(btn).toHaveTextContent('Approve visuals')
    expect(screen.queryByTestId('approve-copy')).not.toBeInTheDocument()

    fireEvent.click(btn)
    await waitFor(() => expect(approveMediaMock).toHaveBeenCalledWith(9, expect.any(Object)))
    expect(approvePostMock).not.toHaveBeenCalled()
  })

  it('does not show Performance tab for non-published posts', async () => {
    render(<PostScreen inlinePostId={9} />)
    await screen.findByTestId('approve-media')
    expect(screen.queryByTestId('tab-performance')).not.toBeInTheDocument()
  })
})

describe('PostScreen Performance tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPostMock.mockResolvedValue({
      post: {
        id: 9,
        status: 'published',
        format: 'feed',
        topic: 'Live post',
        hook: 'Hook',
        caption: 'Caption',
        hashtags: '',
        agent_output: null,
        error: null,
        image_url: 'https://cdn.example/a.png',
        reel_url: null,
        account_id: 'acct1',
        instagram_permalink: 'https://instagram.com/p/abc',
      },
      slides: [],
    })
    getInsightsMock.mockResolvedValue({
      metrics: { reach: 1000, views: 2000, saved: 50, shares: 10, comments: 5, likes: 80 },
      note: null,
    })
    getCommentsMock.mockResolvedValue({
      comments: [{ id: 'c1', text: 'Nice', username: 'fan' }],
    })
  })

  it('shows Performance tab and loads metrics for published posts', async () => {
    render(<PostScreen inlinePostId={9} />)
    const tab = await screen.findByTestId('tab-performance')
    fireEvent.click(tab)
    await waitFor(() => expect(screen.getByTestId('performance-panel')).toBeInTheDocument())
    expect(screen.getByText(/data delayed up to 48h/i)).toBeInTheDocument()
    expect(getInsightsMock).toHaveBeenCalledWith(9)
    await waitFor(() => expect(screen.getByText('1,000')).toBeInTheDocument())
    expect(screen.getByText('Open on Instagram')).toHaveAttribute(
      'href',
      'https://instagram.com/p/abc',
    )
  })
})
