/**
 * e2e-link-crosstalk.ts — throwaway proof for LINK.CROSSTALK (run ONLY with a throwaway HOME).
 *
 *   HOME=/tmp/x AGENTISTICS_THROWAWAY=1 bun packages/server/scripts/e2e-link-crosstalk.ts
 *
 * Real tmux (the data dir's own socket), real processes, real `~/.claude/sessions/<pid>.json`
 * records, the real registry file and the real poller. Two "claude" sessions share one folder; the
 * first one's pane also runs a NESTED process whose record inherits the pane's `tmux` field (what a
 * preview server spawning claude does). A third pane runs a session whose registry record was lost
 * after a resume; its retired predecessor carries a parent, a task and a subtask.
 */
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sessionIdentityKey } from '@agentistics/core'
import { HOME_DIR, AGENTISTICS_DATA_DIR } from '../server/config'
import { TMUX_SOCKET } from '../server/sessions/tmux-socket'
import { tmuxBackend } from '../server/sessions/backend-tmux'
import { createSessionsPoller } from '../server/sessions/sessions-host'
import { loadHarnessSessions } from '../server/sessions/harness-sessions'
import { readRegistry, addSession, patchSession } from '../server/sessions/registry'
import { readProcStart } from '../server/sessions/proc-liveness'

if (process.env.AGENTISTICS_THROWAWAY !== '1' || !HOME_DIR.startsWith('/tmp/')) {
  console.error('refusing: run with a /tmp HOME and AGENTISTICS_THROWAWAY=1')
  process.exit(2)
}

if (TMUX_SOCKET === 'agentop') {
  console.error('refusing: the tmux socket resolved to the owner\'s fleet socket')
  process.exit(2)
}
const ws = join(HOME_DIR, 'ws')
const run = join(HOME_DIR, 'run')
const recDir = join(HOME_DIR, '.claude', 'sessions')
for (const d of [ws, run, recDir, AGENTISTICS_DATA_DIR]) mkdirSync(d, { recursive: true })
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...a], { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Pane m1: the "leader" (bash = the pane's claude) starts a nested child that will also claim m1.
writeFileSync(join(run, 'leader.sh'), `echo $$ > ${run}/leader.pid
bash -c 'echo $$ > ${run}/nested.pid; exec sleep 600' &
while :; do sleep 600; done\n`)
writeFileSync(join(run, 'plain.sh'), `echo $$ > ${run}/$1.pid; while :; do sleep 600; done\n`)
const ids = { m1: 'e2eleader1', m2: 'e2esecond2', m3: 'e2eresumed' }
tmux('new-session', '-d', '-s', `agentop-${ids.m1}`, '-c', ws, `bash ${run}/leader.sh`)
tmux('new-session', '-d', '-s', `agentop-${ids.m2}`, '-c', ws, `bash ${run}/plain.sh m2`)
tmux('new-session', '-d', '-s', `agentop-${ids.m3}`, '-c', ws, `bash ${run}/plain.sh m3`)
await sleep(800)
const pid = (n: string) => Number(readFileSync(join(run, `${n}.pid`), 'utf8').trim())

async function record(p: number, sessionId: string, managed: string, mtimeOffsetS: number) {
  const f = join(recDir, `${p}.json`)
  writeFileSync(f, JSON.stringify({
    pid: p, sessionId, cwd: ws, tmux: `agentop-${managed}:@0.%0`, kind: 'interactive',
    startedAt: Date.now(), procStart: await readProcStart(p),
  }))
  const t = Date.now() / 1000 + mtimeOffsetS
  utimesSync(f, t, t)
}
await record(pid('leader'), 'c-leader', ids.m1, -60)
await record(pid('nested'), 'c-preview', ids.m1, 0) // NEWER — newest-wins handed it m1 before the fix
await record(pid('m2'), 'c-second', ids.m2, -30)
await record(pid('m3'), 'c-resumed', ids.m3, -10)

const t0 = '2026-10-09T10:00:00.000Z'
await addSession({ id: ids.m1, harness: 'claude', cwd: ws, createdAt: t0, conversationId: 'c-leader', conversationLink: 'assigned', conversationLinkVia: 'assigned-id' })
await addSession({ id: ids.m2, harness: 'claude', cwd: ws, createdAt: t0, conversationId: 'c-second', conversationLink: 'assigned', conversationLinkVia: 'assigned-id' })
// The predecessor the resume retired; the resumed row's own record is the one that got lost.
await addSession({
  id: 'e2epredece', harness: 'claude', cwd: ws, createdAt: t0, endedAt: '2026-10-09T21:49:00.000Z',
  conversationId: 'c-resumed', parentSessionId: 'e2eparent1', taskId: 't-e2e', subtaskId: 's-e2e', task: 'E2E', label: 'LEADER',
})

const poller = createSessionsPoller({
  backend: tmuxBackend,
  readRegistry,
  scanProcesses: async () => ({ procs: [] }),
  loadHarnessSessions: () => loadHarnessSessions(['claude']),
  recordConversation: (id, conversationId, conversationLink, conversationLinkVia) =>
    patchSession(id, { conversationId, conversationLink, ...(conversationLinkVia ? { conversationLinkVia } : {}) }),
  adoptSessions: async records => { for (const r of records) await addSession(r) },
})

let failures = 0
const check = (what: string, ok: boolean, got: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)})`}`)
  if (!ok) failures++
}
try {
  await poller.poll()
  await poller.poll()
  const reg = await readRegistry()
  const by = (id: string) => reg.find(r => r.id === id)
  check('m1 (pane holding a nested claude) keeps its own conversation', by(ids.m1)?.conversationId === 'c-leader', by(ids.m1)?.conversationId)
  check('m2 (same folder) keeps its own conversation', by(ids.m2)?.conversationId === 'c-second', by(ids.m2)?.conversationId)
  check('no row took the nested process conversation', !reg.some(r => r.conversationId === 'c-preview'), reg.map(r => r.conversationId))
  const m3 = by(ids.m3)
  check('resumed row was adopted', !!m3, m3)
  check('adopted row keeps parentSessionId', m3?.parentSessionId === 'e2eparent1', m3?.parentSessionId)
  check('adopted row keeps task/subtask', m3?.taskId === 't-e2e' && m3?.subtaskId === 's-e2e', [m3?.taskId, m3?.subtaskId])
  check('adopted row keeps the sidebar folder key (conversation)', !!m3 && sessionIdentityKey(m3) === sessionIdentityKey(by('e2epredece')!), m3 && sessionIdentityKey(m3))
  check('adopted row keeps the label', m3?.label === 'LEADER', m3?.label)
} finally {
  for (const id of Object.values(ids)) { try { tmux('kill-session', '-t', `agentop-${id}`) } catch {} }
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
