import { describe, expect, test } from 'bun:test'
import { checkDiskCeiling, diskStatus, type DiskWatchDeps } from './disk-watch'

const GiB = 1024 ** 3

function deps(over: Partial<DiskWatchDeps> & { free?: number } = {}) {
  const sent: Array<{ id: string; text: string }> = []
  const notices: Array<{ code: string; meta: Record<string, unknown> }> = []
  let state: { lastNoticeMs: number | null; wslSaid: boolean } = { lastNoticeMs: null, wslSaid: false }
  let scans = 0
  const d: DiskWatchDeps = {
    volume: async () => ({ path: '/home/x', freeBytes: (over.free ?? 10) * GiB, totalBytes: 100 * GiB }),
    config: async () => undefined,
    freeable: async () => { scans++; return { bytes: 5 * GiB, count: 3 } },
    rows: async () => [
      { id: 'lead', running: true }, { id: 'worker', running: true }, { id: 'gone', running: false },
    ],
    roleOf: async id => (id === 'worker' ? 'worker' : 'leader'),
    send: async (id, text) => { sent.push({ id, text }); return { ok: true } },
    notify: (code, meta) => { notices.push({ code, meta }) },
    readState: async () => state,
    writeState: async s => { state = s },
    lang: async () => 'en',
    wsl: () => true,
    now: () => 1_000_000,
    ...over,
  }
  return { d, sent, notices, scans: () => scans, state: () => state }
}

describe('checkDiskCeiling', () => {
  test('above the floor: nothing is scanned or sent', async () => {
    const t = deps({ free: 60 })
    await checkDiskCeiling(t.d)
    expect([t.scans(), t.sent.length, t.notices.length]).toEqual([0, 0, 0])
  })

  test('under the floor: the person and each live LEADER are told once, with the freeable amount', async () => {
    const t = deps()
    await checkDiskCeiling(t.d)
    await checkDiskCeiling(t.d)
    expect(t.sent.map(s => s.id)).toEqual(['lead'])
    expect(t.sent[0]!.text).toContain('5.0 GB')
    expect(t.sent[0]!.text).toContain('set-sparse true')
    expect(t.notices.length).toBe(1)
    expect(t.notices[0]!.code).toBe('clean.disk-low-wsl')
    expect(t.notices[0]!.meta.freed).toBe('5.0 GB')
  })

  test('the WSL note is said once; later notices leave it out', async () => {
    let now = 1_000_000
    const t = deps({ now: () => now })
    await checkDiskCeiling(t.d)
    now += 2 * 86_400_000
    await checkDiskCeiling(t.d)
    expect(t.notices.map(n => n.code)).toEqual(['clean.disk-low-wsl', 'clean.disk-low'])
    expect(t.sent[1]!.text).not.toContain('set-sparse')
  })

  test('GET /api/clean/disk says the WSL sentence once, remembered, not on every read', async () => {
    const t = deps({ free: 60 })
    expect((await diskStatus(t.d)).wslNote).toContain('set-sparse true')
    expect(t.state().wslSaid).toBe(true)
    expect((await diskStatus(t.d)).wslNote).toBeNull()
  })

  test('after a read has said it, the notice leaves it out; off WSL nothing is recorded', async () => {
    const t = deps()
    await diskStatus(t.d)
    await checkDiskCeiling(t.d)
    expect(t.notices[0]!.code).toBe('clean.disk-low')
    const off = deps({ wsl: () => false })
    expect((await diskStatus(off.d)).wslNote).toBeNull()
    expect(off.state().wslSaid).toBe(false)
  })

  test('a volume that cannot be read says nothing', async () => {
    const t = deps({ volume: async () => null })
    await checkDiskCeiling(t.d)
    expect(t.notices.length).toBe(0)
  })
})
