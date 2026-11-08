/**
 * MAC.OPENCODE-MUDO — a managed opencode 2.x pane and `tui/tabs.json`. The tabs record is keyed by DIRECTORY, so
 * in a shared workspace (several leaders in one folder, a dead TUI's leftover tab) the pane's process is credited
 * with a tab that is not its own. That id may fill a row with no conversation; it must never MOVE a linked row.
 */
import { describe, expect, it } from 'bun:test'
import type { HarnessId } from '@agentistics/core'
import { expandOpencodeTabs, type HarnessProcess } from '../live-sessions'
import { createSessionsPoller } from './sessions-host'
import type { BackendSession, ManagedSession, SessionBackend } from './types'

const NOW = 1_786_600_000_000
const OWN = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const FOREIGN = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb'
const managed = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'opencode' as HarnessId, cwd: '/ws', createdAt: new Date(NOW - 60_000).toISOString(), ...over,
})
const bs = (id: string): BackendSession => ({ id, createdMs: NOW - 60_000, attached: false, alive: true, lastActivityMs: NOW - 30_000 })
function backend(ids: string[], panePids: Record<string, number>): SessionBackend {
  return {
    id: 'tmux',
    async unavailable() { return undefined },
    async spawn() {},
    async list() { return ids.map(bs) },
    async capture() { return ['x'] },
    async captureTerminal() { return { lines: ['x'], info: { cols: 80, rows: 1, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } } },
    async kill() { return true },
    attachCommand(id) { return ['tmux', 'attach', id] },
    async detachHint() { return 'Ctrl-b then d' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
    async sendPaste() { return true },
    async listPanePids() { return new Map(Object.entries(panePids)) },
  }
}
async function poll(rows: ManagedSession[], procs: HarnessProcess[]) {
  const writes: Array<[string, string]> = []
  const p = createSessionsPoller({
    backend: backend(rows.map(r => r.id), { a: 101 }),
    readRegistry: async () => rows,
    scanProcesses: async () => ({ procs }),
    now: () => NOW,
    recordConversation: async (id, cid) => { writes.push([id, cid]) },
  })
  await p.poll()
  return writes
}
const pane: HarnessProcess = { harness: 'opencode', cwd: '/ws', pid: 101, startedMs: NOW - 60_000, stdinIsTty: true }

describe('managed opencode pane × tabs.json', () => {
  it('a foreign tab credited by directory never moves a row already linked to its own conversation', async () => {
    const procs = expandOpencodeTabs([pane], new Map([[101, [FOREIGN]]]))
    expect(procs[0]!.sessionFrom).toBe('tabs')
    expect(await poll([managed('a', { conversationId: OWN })], procs)).toEqual([])
  })
  it('the same tab still FILLS a row that has no conversation yet (the fresh-spawn link keeps working)', async () => {
    const procs = expandOpencodeTabs([pane], new Map([[101, [OWN]]]))
    expect(await poll([managed('a')], procs)).toEqual([['a', OWN]])
  })
  it('an id the process itself states (argv -s) still moves the row, as before', async () => {
    expect(await poll([managed('a', { conversationId: OWN })], [{ ...pane, sessionId: FOREIGN }])).toEqual([['a', FOREIGN]])
  })
})
