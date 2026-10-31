import { cn } from '../../lib/utils'

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border border-transparent px-2 py-0.5 text-[11px] font-semibold tracking-wide',
        className
      )}
      {...props}
    />
  )
}
