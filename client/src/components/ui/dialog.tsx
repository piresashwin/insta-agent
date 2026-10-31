import { cn } from '../../lib/utils'

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#15191e]/45 p-4"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="dash-in max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-md border border-border bg-card shadow-[0_12px_40px_rgba(21,25,30,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export function DialogContent({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('p-5 sm:p-6', className)}>{children}</div>
}

export function DialogHeader({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('mb-4 space-y-1 border-b border-border pb-4', className)}>{children}</div>
}

export function DialogTitle({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <h2 className={cn('text-base font-semibold tracking-tight text-foreground', className)}>
      {children}
    </h2>
  )
}
