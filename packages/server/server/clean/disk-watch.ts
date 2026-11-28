/**
 * disk-watch.ts — the disk-floor check (DISCO.WORKTREES), with every effect injected; the real ones
 * live in `clean-suggest.ts`. Under the floor it tells the person (a notification that opens the
 * Cleanup dialog) and each live LEADER session, at most once a day. The costly part — measuring what
 * cleanup would free — runs only when low.
 */
import { fmtBytes } from './clean-plan'
import { ceilingBytes, diskNoticeText, evaluateDiskCeiling, resolveCeiling, wslNote, type DiskCeiling, type DiskVolume } from './disk-ceiling'

export interface DiskWatchState { lastNoticeMs: number | null; wslSaid: boolean }

export interface DiskWatchDeps {
  /** The fullest filesystem holding a worktree; null = could not be read. */
  volume(): Promise<DiskVolume | null>
  config(): Promise<Partial<DiskCeiling> | undefined>
  /** What the safe cleanup would free (a real disk walk). */
  freeable(): Promise<{ bytes: number; count: number }>
  rows(): Promise<readonly { id: string; conversationId?: string; running: boolean }[]>
  roleOf(id: string, conversationId?: string): Promise<string | undefined>
  send(id: string, text: string): Promise<{ ok: boolean }>
  notify(code: 'clean.disk-low' | 'clean.disk-low-wsl', meta: Record<string, string | number>): void
  readState(): Promise<DiskWatchState>
  writeState(state: DiskWatchState): Promise<void>
  lang(): Promise<'en' | 'pt'>
  wsl(): boolean
  now(): number
}

export async function checkDiskCeiling(d: DiskWatchDeps): Promise<void> {
  const volume = await d.volume()
  if (!volume) return
  const cfg = resolveCeiling(await d.config())
  const state = await d.readState()
  const step = evaluateDiskCeiling({ ...volume, cfg, lastNoticeMs: state.lastNoticeMs, nowMs: d.now() })
  if (!step.notify) {
    if (step.lastNoticeMs !== state.lastNoticeMs) await d.writeState({ ...state, lastNoticeMs: step.lastNoticeMs })
    return
  }
  const free = await d.freeable()
  // Said once per machine: the WSL sentence is about the platform, not about this episode.
  const sayWsl = !state.wslSaid && d.wsl()
  // Recorded BEFORE sending: a failed delivery is not worth a second notice a minute later.
  await d.writeState({ lastNoticeMs: step.lastNoticeMs, wslSaid: state.wslSaid || sayWsl })
  const thresholdBytes = ceilingBytes(volume.totalBytes, cfg)
  d.notify(sayWsl ? 'clean.disk-low-wsl' : 'clean.disk-low', { free: fmtBytes(volume.freeBytes), floor: fmtBytes(thresholdBytes), freed: fmtBytes(free.bytes), count: free.count })
  const text = diskNoticeText({ lang: await d.lang(), freeBytes: volume.freeBytes, thresholdBytes, freeableBytes: free.bytes, count: free.count, wsl: sayWsl })
  for (const row of await d.rows()) {
    if (!row.running || (await d.roleOf(row.id, row.conversationId)) !== 'leader') continue
    await d.send(row.id, text).catch(() => ({ ok: false }))
  }
}

export interface DiskStatus { volume: DiskVolume | null; floorBytes: number | null; low: boolean; wslNote: string | null }

/** GET /api/clean/disk: cheap (statfs only); what cleanup would free comes from the plan. */
export async function diskStatus(d: Pick<DiskWatchDeps, 'volume' | 'config' | 'wsl' | 'lang' | 'readState' | 'writeState'>): Promise<DiskStatus> {
  const volume = await d.volume()
  if (!volume) return { volume, floorBytes: null, low: false, wslNote: null }
  const floorBytes = ceilingBytes(volume.totalBytes, resolveCeiling(await d.config()))
  // The WSL sentence is said ONCE per machine, here or in the notice, whichever comes first.
  let note: string | null = null
  const state = await d.readState()
  if (!state.wslSaid && d.wsl()) {
    await d.writeState({ ...state, wslSaid: true })
    note = wslNote(await d.lang())
  }
  return { volume, floorBytes, low: volume.freeBytes < floorBytes, wslNote: note }
}
