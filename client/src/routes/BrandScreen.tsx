import { useState } from 'react'
import { BrandProfilesPanel } from '../components/BrandProfiles'
import { toast } from 'sonner'

export function BrandScreen() {
  const [, setError] = useState<string | null>(null)
  return (
    <BrandProfilesPanel
      onError={(msg) => {
        setError(msg)
        if (msg) toast.error(msg)
      }}
    />
  )
}
