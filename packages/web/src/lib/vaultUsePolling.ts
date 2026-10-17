import type { Reply, VaultUseRequest } from './vaultApi'

/** Poll only an open vault. A refusal parks this subscription until a vault state change restarts it. */
export function pollVaultUseRequests({ open, load, onRequests, onRefused, schedule = fn => setTimeout(fn, 2_000), cancel = clearTimeout }: {
  open: boolean
  load: () => Promise<Reply<{ requests: VaultUseRequest[] }>>
  onRequests: (requests: VaultUseRequest[]) => void
  onRefused: () => void
  schedule?: (fn: () => void) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}): () => void {
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    let refused = false
    try {
      const r = await load()
      if (!alive) return
      if (r.ok) onRequests(r.requests ?? [])
      else if (r.status === 401 || r.status === 403) {
        refused = true
        onRequests([])
        onRefused()
      }
    } catch { /* A transient network failure retries quietly. */ }
    if (alive && !refused) timer = schedule(() => { void poll() })
  }
  if (open) void poll()
  else onRequests([])
  return () => { alive = false; if (timer !== undefined) cancel(timer) }
}
