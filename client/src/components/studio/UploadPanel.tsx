import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { Button } from '../ui/button'
import { listAssets, createAsset, type AssetItem } from '../../api'

export function UploadPanel({
  brandId,
  postId,
  onPick,
}: {
  brandId?: number | null
  postId?: number | null
  onPick: (asset: AssetItem) => void
}) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const { data } = useQuery({
    queryKey: ['assets', brandId, postId],
    queryFn: () =>
      listAssets({
        ...(brandId ? { brand_id: brandId } : {}),
        ...(postId ? { post_id: postId } : {}),
        kind: 'image',
      }),
  })

  const register = useMutation({
    mutationFn: createAsset,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets'] })
      toast.success('Asset added')
    },
  })

  async function onFile(file: File) {
    setBusy(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = dataUrl
      })
      await register.mutateAsync({
        kind: 'image',
        url: dataUrl,
        w: img.naturalWidth,
        h: img.naturalHeight,
        source: 'upload',
        provider: 'local',
        prompt: null,
        sha256: null,
        post_id: postId ?? null,
        brand_id: brandId ?? null,
      })
    } catch {
      toast.error('Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const assets = data?.assets ?? []

  return (
    <div className="p-3 space-y-3" data-testid="upload-panel">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
          e.target.value = ''
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-2"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={13} />
        {busy ? 'Uploading…' : 'Upload image'}
      </Button>

      <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
        {assets.map((a) => (
          <button
            key={a.id}
            onClick={() => onPick(a)}
            className="aspect-square rounded-[var(--radius-control)] border border-[var(--border)] overflow-hidden hover:border-[var(--accent)]"
          >
            <img src={a.url} alt="" className="w-full h-full object-cover" />
          </button>
        ))}
        {assets.length === 0 && (
          <p className="col-span-2 text-xs text-[var(--muted)] text-center py-4">No assets yet.</p>
        )}
      </div>
    </div>
  )
}
