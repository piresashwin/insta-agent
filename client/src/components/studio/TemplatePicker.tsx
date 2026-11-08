import { listTemplates, type TemplateId, type PostFormat } from '@instagram-agent/shared'

export function TemplatePicker({
  format,
  onPick,
}: {
  format: PostFormat
  onPick: (id: TemplateId) => void
}) {
  const templates = listTemplates(format)

  return (
    <div className="p-3 space-y-2" data-testid="template-picker">
      <p className="text-xs text-[var(--muted)] mb-1">Start from a template</p>
      <div className="grid grid-cols-1 gap-1.5">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => onPick(t.id)}
            className="text-left px-3 py-2 rounded-[var(--radius-control)] border border-[var(--border)] text-xs hover:border-[var(--accent)] hover:bg-[var(--active)] transition-colors"
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}
