'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { attachMaintenancePhoto, uploadMaintenancePhoto } from '@/lib/maintenance/actions.ts'

// The recovery path for a photo dropped mid-upload during submission (see
// lib/maintenance/actions.ts's uploadMaintenancePhoto), and an ordinary
// feature in its own right - a tenant remembering a photo after the fact
// should not need to file a second request.
export function AddPhotoForm({ ticketId }: { ticketId: string }) {
  const router = useRouter()
  const [status, setStatus] = useState<'idle' | 'uploading' | 'error'>('idle')

  async function handleFile(file: File | undefined) {
    if (!file) return
    setStatus('uploading')
    const uploaded = await uploadMaintenancePhoto(file)
    if ('error' in uploaded) {
      setStatus('error')
      return
    }
    await attachMaintenancePhoto(ticketId, uploaded.id)
    setStatus('idle')
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 w-fit cursor-pointer items-center rounded-md border px-4 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none">
        {status === 'uploading' ? 'Uploading…' : 'Add a photo'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          disabled={status === 'uploading'}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            void handleFile(file)
          }}
        />
      </label>
      {status === 'error' && (
        <p role="alert" className="text-red-700 dark:text-red-400">
          That photo could not be uploaded. Please try again.
        </p>
      )}
    </div>
  )
}
