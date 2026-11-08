import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InsightsScreen } from './InsightsScreen'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode
    to: string
    params?: Record<string, string>
  }) => (
    <a href={`${to.replace('$postId', params?.postId || '')}`}>{children}</a>
  ),
}))

const getInsightsAccount = vi.fn()
const getInsightsDigest = vi.fn()

vi.mock('../api', () => ({
  listInstagramConnections: vi.fn(async () => ({
    connections: [
      {
        id: 1,
        account_id: 'acct1',
        status: 'connected',
        ig_username: 'brand',
        default_brand_profile_id: 7,
        needs_reconnect: false,
      },
    ],
  })),
  listBrandProfiles: vi.fn(async () => ({
    brands: [{ id: 7, name: 'Brand' }],
  })),
  getInsightsAccount: (...args: unknown[]) => getInsightsAccount(...args),
  getInsightsDigest: (...args: unknown[]) => getInsightsDigest(...args),
}))

function renderInsights() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InsightsScreen />
    </QueryClientProvider>,
  )
}

describe('InsightsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getInsightsAccount.mockResolvedValue({
      account_id: 'acct1',
      daily: [
        { date: '2026-10-01', followers: 100, reach: 10, views: 20, final: true },
        { date: '2026-11-01', followers: 120, reach: 15, views: 25, final: false },
      ],
      audience: { hidden: true, reason: 'fewer than 100 followers' },
      publish_markers: [],
    })
  })

  it('shows insufficient-data empty state and stat strip', async () => {
    getInsightsDigest.mockResolvedValue({ insufficientData: true, count: 3, needed: 8 })
    renderInsights()
    await waitFor(() => expect(screen.getByTestId('insights-insufficient')).toBeInTheDocument())
    expect(screen.getByTestId('insights-insufficient')).toHaveTextContent('3 of 8')
    expect(screen.getByTestId('insights-stat-strip')).toBeInTheDocument()
    expect(screen.getByTestId('insights-leaderboard-empty')).toBeInTheDocument()
    expect(screen.getByTestId('insights-audience-hidden')).toHaveTextContent(
      'fewer than 100 followers',
    )
  })

  it('renders leaderboard links when digest has posts', async () => {
    getInsightsDigest.mockResolvedValue({
      brand_profile_id: 7,
      correlational: true,
      post_count: 10,
      median_score: 0.12,
      finding_line: 'Reels are winning',
      top: [
        {
          post_id: 42,
          hook: 'Top hook',
          first_line: null,
          format: 'reel',
          pillar: 'edu',
          score: 0.5,
          reach: 100,
          saved: 10,
          shares: 2,
          follows: 1,
          permalink: null,
        },
      ],
      bottom: [],
      lift_by_format: [{ key: 'reel', mean_score: 0.5, lift_vs_median: 0.4, count: 5 }],
      lift_by_pillar: [],
    })
    renderInsights()
    await waitFor(() => expect(screen.getByTestId('insights-finding')).toHaveTextContent('Reels'))
    const link = screen.getByRole('link', { name: 'Top hook' })
    expect(link).toHaveAttribute('href', expect.stringContaining('42'))
    expect(screen.getByTestId('insights-leaderboard')).toBeInTheDocument()
  })
})
