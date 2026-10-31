import { Label } from './ui/label'
import { cn } from '../lib/utils'

export function PageShell({
  brand,
  nav,
  actions,
  children,
}: {
  brand: React.ReactNode
  nav: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex h-12 max-w-[1200px] items-center gap-6 px-4">
          <div className="flex min-w-0 items-center gap-2.5">{brand}</div>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">{nav}</nav>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
        {/* signature: printer registration rule */}
        <div className="h-px w-full bg-rule/70" />
      </header>
      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-6">{children}</main>
    </div>
  )
}

export function NavTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative h-8 shrink-0 rounded-sm px-2.5 text-[12px] font-semibold tracking-tight transition-colors sm:px-3 sm:text-[13px]',
        active
          ? 'text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      )}
    >
      {children}
      {active && <span className="absolute inset-x-1.5 -bottom-[7px] h-0.5 bg-rule" />}
    </button>
  )
}

export function Section({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-md border border-border bg-card', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      <div className="p-0">{children}</div>
    </section>
  )
}

export function FormField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div>{children}</div>
    </div>
  )
}

/** @deprecated Prefer PageShell */
export function PageLayout({
  title,
  actions,
  children,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <PageShell brand={<span className="font-semibold">{title}</span>} nav={null} actions={actions}>
      {children}
    </PageShell>
  )
}

/** @deprecated Prefer Section */
export function SectionCard(props: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return <Section {...props} />
}
