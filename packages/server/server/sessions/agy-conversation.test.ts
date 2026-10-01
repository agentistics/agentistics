import { describe, expect, it } from 'bun:test'
import {
  agyLogCollisions, agyLogFromFds, agyLogStartMs, agyLogWorkspaces, conversationFromAgyLog,
  conversationFromSpawnWindow,
} from './agy-conversation'

/**
 * The fixtures are REAL lines, captured on 2026-09-08 from agy 1.1.27 on this machine — the log of
 * the process agentop spawned at 10:03:56, which created conversation 39783297-…. A format this
 * undocumented is worth pinning against bytes somebody actually saw.
 */
const REAL_LINE =
  'ERROR: logging before google.Init: I0908 10:03:58.569478     218 server.go:1153] '
  + 'Created conversation 39783297-b1b0-49bf-9f56-b809ee1933db'

const REAL_LOG = [
  'ERROR: logging before google.Init: I0908 10:03:50.150653      82 server.go:1530] Starting language server process with pid 613917',
  REAL_LINE,
  'ERROR: logging before google.Init: I0908 10:03:58.571000     218 server.go:1160] getConversationDetail: found conversation 39783297-b1b0-49bf-9f56-b809ee1933db (active=true)',
].join('\n')

describe('conversationFromAgyLog', () => {
  it('reads the conversation agy says it created', () => {
    expect(conversationFromAgyLog(REAL_LOG)).toBe('39783297-b1b0-49bf-9f56-b809ee1933db')
  })

  it('answers null for a log that created nothing', () => {
    const noneYet = [
      'ERROR: logging before google.Init: I0908 10:32:50.150653      82 server.go:1530] Starting language server process with pid 613917',
      'ERROR: logging before google.Init: E0908 10:32:50.415817      60 errorreport.go:224] You are not logged into Antigravity.',
    ].join('\n')
    expect(conversationFromAgyLog(noneYet)).toBeNull()
  })

  it('answers null for an empty log', () => {
    expect(conversationFromAgyLog('')).toBeNull()
  })

  /**
   * One process can create a second conversation (agy's own `/new`). The one it is WRITING is the
   * last one it made, so a reader that took the first would name a conversation the session has
   * already left — and it would look perfectly right, which is the failure mode this whole feature
   * exists to avoid.
   */
  it('takes the LAST conversation when one process created several', () => {
    const twice = [
      REAL_LINE,
      'ERROR: logging before google.Init: I0908 10:41:02.100000     218 server.go:1153] '
      + 'Created conversation aacfe2ab-ef77-470d-804b-099bfe8e40be',
    ].join('\n')
    expect(conversationFromAgyLog(twice)).toBe('aacfe2ab-ef77-470d-804b-099bfe8e40be')
  })

  /** A line that merely mentions a conversation is not a line that created one. */
  it('ignores a conversation it only looked up', () => {
    const lookupOnly =
      'ERROR: logging before google.Init: I0908 10:03:58.571000     218 server.go:1160] '
      + 'getConversationDetail: found conversation 39783297-b1b0-49bf-9f56-b809ee1933db (active=true)'
    expect(conversationFromAgyLog(lookupOnly)).toBeNull()
  })

  /** Undocumented format, read like one: anything that is not a uuid is not an answer. */
  it('refuses a created line whose id is not a uuid', () => {
    expect(conversationFromAgyLog('server.go:1153] Created conversation not-a-uuid')).toBeNull()
  })
})

describe('agyLogFromFds', () => {
  const LOG = '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260908_100356.log'

  it('picks agy\'s own log out of the process\'s open files', () => {
    expect(agyLogFromFds([
      '/dev/pts/3',
      '/home/mithrandir/.gemini/antigravity-cli/conversation_summaries.db',
      '/home/mithrandir/.gemini/antigravity-cli/conversation_summaries.db-wal',
      '/home/mithrandir/.gemini/antigravity-cli/crashes/crash_613917_f08b6119.log',
      LOG,
    ])).toBe(LOG)
  })

  it('answers null when the process has no agy log open', () => {
    expect(agyLogFromFds(['/dev/pts/3', '/home/mithrandir/.bashrc'])).toBeNull()
  })

  it('answers null for a process with no open files at all', () => {
    expect(agyLogFromFds([])).toBeNull()
  })

  /**
   * A crash log sits in the same tree and ends in `.log`, and it carries a pid rather than a
   * conversation. Matching it would hand the reader a file that names nothing.
   */
  it('does not mistake a crash log for the session log', () => {
    expect(agyLogFromFds([
      '/home/mithrandir/.gemini/antigravity-cli/crashes/crash_613917_f08b6119-5e4c-48de-b201-5ccb16dee285.log',
    ])).toBeNull()
  })

  /**
   * Two session logs open at once is a shape nobody has seen and nothing here can resolve: picking
   * either would be a guess wearing a measurement's clothes. Same rule as `planFirstSightingClaims`
   * — every ambiguity errs toward refusing.
   */
  it('refuses when two session logs are open', () => {
    expect(agyLogFromFds([
      LOG,
      '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260908_103250.log',
    ])).toBeNull()
  })

  /** The same file counted twice (a dup'd fd) is still one file, and must not read as ambiguity. */
  it('accepts the same log appearing on two descriptors', () => {
    expect(agyLogFromFds([LOG, LOG])).toBe(LOG)
  })
})

/**
 * Reproduced live 2026-09-17: two real agy 1.2.5 processes, spawned within the same wall-clock
 * second, both `/proc/<pid>/fd/1` resolved to `cli-20260917_203310.log`, and after both completed
 * a full turn the file held exactly ONE `Created conversation` line, not two — the other write was
 * lost, not merely reordered. `agyLogCollisions` is the guard: it never trusts a log more than one
 * live pid has open.
 */
describe('agyLogCollisions', () => {
  const SHARED = '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260917_203310.log'
  const OTHER = '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260917_154127.log'

  it('refuses both pids that share one log', () => {
    const collided = agyLogCollisions(new Map([[111, SHARED], [222, SHARED]]))
    expect(collided.has(111)).toBe(true)
    expect(collided.has(222)).toBe(true)
    expect(collided.size).toBe(2)
  })

  it('refuses every pid sharing the log when three or more collide', () => {
    const collided = agyLogCollisions(new Map([[1, SHARED], [2, SHARED], [3, SHARED]]))
    expect([...collided].sort()).toEqual([1, 2, 3])
  })

  it('trusts a pid whose log nobody else has open', () => {
    const collided = agyLogCollisions(new Map([[111, SHARED], [222, OTHER]]))
    expect(collided.has(111)).toBe(false)
    expect(collided.has(222)).toBe(false)
    expect(collided.size).toBe(0)
  })

  it('never flags a pid with no agy log open', () => {
    // `null` is "this pid has nothing to collide with", not a value that can collide with itself.
    const collided = agyLogCollisions(new Map([[111, null], [222, null]]))
    expect(collided.size).toBe(0)
  })

  it('answers empty for no pids at all', () => {
    expect(agyLogCollisions(new Map()).size).toBe(0)
  })
})

/**
 * THE POST-MORTEM READ. The fixtures are the shape of the owner's own machine on 2026-10-01 (agy
 * 1.2.14): the session 'ADS-NEXT VPC' was spawned at 15:31:59.963 local, lived three minutes, and
 * ended with no conversation recorded — although its log, `cli-20261001_153200.log`, said
 * `Created conversation …` three seconds after it opened. The link had been attempted only while
 * the process was alive.
 */
const at = (h: number, m: number, sec: number, ms = 0) => new Date(2026, 9, 1, h, m, sec, ms).getTime()

const logOf = (stamp: string, cwd: string, conv?: string) => ({
  path: `/home/padawan/.gemini/antigravity-cli/log/cli-${stamp}.log`,
  text: [
    `I1001 ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.396968       7 manager.go:108] Creating trajectory store manager with proto store and SQLite store`,
    `I1001 ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.428716       1 server.go:323] Creating CLI server backend: product=antigravity workspaceDirs=[${cwd}] appDataDir=/home/padawan/.gemini/antigravity-cli cascadeManager=true codeAssist=true`,
    ...(conv ? [`I1001 ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.541591     250 server.go:1248] Created conversation ${conv}`] : []),
  ].join('\n'),
})

const CONV_A = '02eefe27-dee3-44e4-87bc-b23ae2aa933f'
const CONV_B = 'b7554d22-679c-4241-b9eb-79493fd4f521'

describe('agyLogStartMs', () => {
  it('reads the local start time off the log name', () => {
    expect(agyLogStartMs('/x/antigravity-cli/log/cli-20261001_153200.log')).toBe(at(15, 32, 0))
  })

  it('refuses a crash log, whose uuid is a crash id and not a time', () => {
    expect(agyLogStartMs('/x/antigravity-cli/crashes/crash_157041_0a37ae18-ba7a-4e37-91fc-b96311b6bc9e.log')).toBeNull()
  })

  it('refuses an impossible date rather than rolling it over', () => {
    expect(agyLogStartMs('/x/log/cli-20261345_256199.log')).toBeNull()
  })
})

describe('agyLogWorkspaces', () => {
  it('reads the directories agy was opened on', () => {
    expect(agyLogWorkspaces(logOf('20261001_153200', '/home/padawan/ads-next').text)).toEqual(['/home/padawan/ads-next'])
  })

  it('answers [] for a log that never says', () => {
    expect(agyLogWorkspaces('nothing here')).toEqual([])
  })
})

describe('conversationFromSpawnWindow', () => {
  const base = { cwd: '/home/padawan/ads-next', spawnedMs: at(15, 31, 59, 963) }

  it('finds the conversation of the one log opened at the spawn, in the row\'s own folder', () => {
    const logs = [logOf('20261001_153200', '/home/padawan/ads-next', CONV_A)]
    expect(conversationFromSpawnWindow({ ...base, logs })).toBe(CONV_A)
  })

  it('refuses a log opened in another folder', () => {
    const logs = [logOf('20261001_153200', '/home/padawan/ads-propostas', CONV_A)]
    expect(conversationFromSpawnWindow({ ...base, logs })).toBeNull()
  })

  it('refuses a log opened long before or long after the spawn', () => {
    expect(conversationFromSpawnWindow({ ...base, logs: [logOf('20261001_153000', '/home/padawan/ads-next', CONV_A)] })).toBeNull()
    expect(conversationFromSpawnWindow({ ...base, logs: [logOf('20261001_153300', '/home/padawan/ads-next', CONV_A)] })).toBeNull()
  })

  it('refuses a matching log that never created a conversation', () => {
    expect(conversationFromSpawnWindow({ ...base, logs: [logOf('20261001_153200', '/home/padawan/ads-next')] })).toBeNull()
  })

  it('refuses when two logs qualify — nothing here can say which one is this row\'s', () => {
    const logs = [
      logOf('20261001_153200', '/home/padawan/ads-next', CONV_A),
      logOf('20261001_153201', '/home/padawan/ads-next', CONV_B),
    ]
    expect(conversationFromSpawnWindow({ ...base, logs })).toBeNull()
  })

  it('takes the last conversation the process created, like the live read', () => {
    const l = logOf('20261001_153200', '/home/padawan/ads-next', CONV_A)
    l.text += `\nI1001 15:32:40.000000     250 server.go:1248] Created conversation ${CONV_B}`
    expect(conversationFromSpawnWindow({ ...base, logs: [l] })).toBe(CONV_B)
  })

  it('refuses a conversation another row already holds', () => {
    const logs = [logOf('20261001_153200', '/home/padawan/ads-next', CONV_A)]
    expect(conversationFromSpawnWindow({ ...base, logs, taken: new Set([CONV_A]) })).toBeNull()
  })

  it('refuses two rows spawned in the same second in one folder — they may share one log', () => {
    const logs = [logOf('20261001_153200', '/home/padawan/ads-next', CONV_A)]
    expect(conversationFromSpawnWindow({ ...base, logs, rivalSpawnsMs: [at(15, 32, 0, 400)] })).toBeNull()
  })

  it('lets two rows in one folder each find their OWN log when they were spawned apart', () => {
    const logs = [
      logOf('20261001_153200', '/home/padawan/ads-next', CONV_A),
      logOf('20261001_153210', '/home/padawan/ads-next', CONV_B),
    ]
    const later = at(15, 32, 9, 900)
    expect(conversationFromSpawnWindow({ ...base, logs, rivalSpawnsMs: [later] })).toBe(CONV_A)
    expect(conversationFromSpawnWindow({ cwd: base.cwd, spawnedMs: later, logs, rivalSpawnsMs: [base.spawnedMs] })).toBe(CONV_B)
  })

  it('answers null with no logs at all', () => {
    expect(conversationFromSpawnWindow({ ...base, logs: [] })).toBeNull()
  })
})
