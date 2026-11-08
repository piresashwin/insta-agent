/**
 * Phase 0 Shell: ruled T-frame layout with sidebar + topbar.
 * Design tokens from Part F of the plan.
 * Phase 1 will add budget meter, model status dot, and brand switcher.
 */
import { Link, Outlet, useMatchRoute } from '@tanstack/react-router'
import { Home, Inbox, Calendar, Paintbrush2, BarChart2, Building2, Activity, Settings, Lightbulb } from 'lucide-react'
import { Toaster } from 'sonner'
import { cn } from '../lib/utils'

type NavItem = {
  label: string
  to: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  badge?: number
  exact?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', to: '/', icon: Home, exact: true },
  { label: 'Inbox', to: '/inbox', icon: Inbox },
  { label: 'Plan', to: '/plan', icon: Lightbulb },
  { label: 'Calendar', to: '/calendar', icon: Calendar },
  { label: 'Studio', to: '/studio/new', icon: Paintbrush2 },
  { label: 'Insights', to: '/insights', icon: BarChart2 },
  { label: 'Brand', to: '/brands/1', icon: Building2 },
  { label: 'Activity', to: '/activity', icon: Activity },
]

function SidebarLink({ item }: { item: NavItem }) {
  const matchRoute = useMatchRoute()
  const active = !!matchRoute({ to: item.to, fuzzy: !item.exact })

  return (
    <Link
      to={item.to}
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors',
        'h-[var(--nav-row)]',
        active
          ? 'bg-[var(--active)] text-[var(--accent-ink)]'
          : 'text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]',
      )}
    >
      <item.icon size={16} className={active ? 'text-[var(--accent)]' : ''} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}

export function Shell() {
  return (
    <div className="flex h-screen overflow-hidden bg-[var(--ground)]">
      {/* Sidebar */}
      <aside
        className="flex flex-col border-r border-[var(--border)] bg-[var(--ground)]"
        style={{ width: 'var(--sidebar-width)' }}
      >
        {/* Product mark */}
        <div className="flex h-[var(--topbar)] items-center border-b border-[var(--border)] px-4">
          <span className="font-semibold tracking-tight text-[var(--text)]" style={{ fontSize: 15 }}>
            Instagram Agent
          </span>
        </div>

        {/* Nav items */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map((item) => (
            <SidebarLink key={item.label + item.to} item={item} />
          ))}
        </nav>

        {/* Pinned bottom: Settings */}
        <div className="border-t border-[var(--border)] px-2 py-3">
          <Link
            to="/settings"
            className="flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-[var(--muted)] transition-colors h-[var(--nav-row)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
          >
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          {/* Budget line placeholder */}
          <div className="mt-2 rounded px-3 py-1.5">
            <div className="text-[11px] text-[var(--muted)]">Budget</div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--accent-track)]">
              <div className="h-1.5 rounded-full bg-[var(--accent)]" style={{ width: '30%' }} />
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted)]">$3.00 of $10 · Nov</div>
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header
          className="flex items-center border-b border-[var(--border)] bg-[var(--surface)] px-6"
          style={{ height: 'var(--topbar)' }}
        >
          <div className="flex flex-1 items-center gap-4">
            {/* Breadcrumb placeholder */}
            <span className="text-sm text-[var(--muted)]">Instagram Agent</span>
          </div>
          {/* Brand switcher placeholder */}
          <div className="flex items-center gap-2 border-l border-[var(--border)] pl-4">
            <span className="text-sm font-medium text-[var(--text)]">Brand 1</span>
          </div>
        </header>

        {/* Screen content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {/* Toast container */}
      <Toaster position="bottom-right" richColors />
    </div>
  )
}
