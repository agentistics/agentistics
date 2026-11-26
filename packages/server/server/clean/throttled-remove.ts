/** Depth-first, non-recursive removal. Capabilities are injected by clean-io, as in G1. */
import { CLEAN_BATCH_ENTRIES, CLEAN_BATCH_PAUSE_MS, waitForCleanHealth, type PaceIo } from './clean-pace'

export interface RemoveIo extends PaceIo {
  /** Postorder; symlinks must be yielded as leaves, never followed. */
  entries: (path: string) => AsyncIterable<string>
  erase: (paths: readonly string[]) => Promise<void>
  onBatch?: (entries: number) => void
}

export async function throttledRemove(path: string, io: RemoveIo): Promise<void> {
  let batch: string[] = [], bytes = 0
  const flush = async () => {
    if (!batch.length) return
    await waitForCleanHealth(io)
    await io.erase(batch)
    io.onBatch?.(batch.length)
    batch = []; bytes = 0
    await io.sleep(CLEAN_BATCH_PAUSE_MS)
  }
  await waitForCleanHealth(io)
  for await (const entry of io.entries(path)) {
    // Bound argv as well as entry count (deep or non-ASCII paths can hit ARG_MAX first).
    const size = new TextEncoder().encode(entry).length + 1
    if (batch.length >= CLEAN_BATCH_ENTRIES || bytes + size > 128 * 1024) await flush()
    batch.push(entry); bytes += size
  }
  await flush()
}
