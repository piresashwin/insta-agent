import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { SetupScreen } from './SetupScreen'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const listInstagramConnections = vi.fn()

vi.mock('../api', () => ({
  listBrandProfiles: vi.fn(async () => ({ brands: [{ id: 1, name: 'B' }] })),
  createBrandProfile: vi.fn(),
  generateBrandProfile: vi.fn(),
  listPosts: vi.fn(async () => ({ posts: [{ id: 1 }] })),
  listInstagramConnections: (...args: unknown[]) => listInstagramConnections(...args),
  mockConnectInstagram: vi.fn(),
  instagramOAuthStartUrl: (id: number) => `/oauth/start/${id}`,
  getBudgetSettings: vi.fn(async () => ({ monthly_cap_usd: 50 })),
  saveBudgetSettings: vi.fn(),
  getHealth: vi.fn(async () => ({
    ok: true,
    roles: { writer: true, judge: true, planner: true, vision: true },
  })),
}))

describe('SetupScreen reconnect banner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows reconnect banner when needs_reconnect is true', async () => {
    listInstagramConnections.mockResolvedValue({
      connections: [
        {
          id: 3,
          account_id: 'acct',
          status: 'connected',
          needs_reconnect: true,
          granted_scopes: null,
        },
      ],
    })
    render(<SetupScreen />)
    // Activate Instagram step (index may vary — click the Connect Instagram header)
    await waitFor(() => expect(screen.getByText(/Connect Instagram/i)).toBeInTheDocument())
    screen.getByText(/Connect Instagram/i).click()
    await waitFor(() => expect(screen.getByTestId('reconnect-banner')).toBeInTheDocument())
    expect(screen.getByText('Reconnect Instagram')).toBeInTheDocument()
  })

  it('hides reconnect banner when scopes are present', async () => {
    listInstagramConnections.mockResolvedValue({
      connections: [
        {
          id: 3,
          account_id: 'acct',
          status: 'connected',
          needs_reconnect: false,
          granted_scopes: 'instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_comments',
        },
      ],
    })
    render(<SetupScreen />)
    await waitFor(() => expect(screen.getByText(/Connect Instagram/i)).toBeInTheDocument())
    screen.getByText(/Connect Instagram/i).click()
    await waitFor(() => expect(screen.getByText(/Connect with Instagram/i)).toBeInTheDocument())
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })
})
