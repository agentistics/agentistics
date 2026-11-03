import { describe, expect, test } from 'bun:test'
import { buildInventory, structuredRelayOwner, type ProcEntry } from './inventory'

const entry = (o: Partial<ProcEntry>): ProcEntry => ({
  pid: 10, ppid: 1, argv: ['/usr/bin/agentop', 'mcp'], exe: '/usr/bin/agentop', rssBytes: 1, swapBytes: 0,
  cpuPercent: 0, ageSec: 1, env: {}, ...o,
})
const ctx = { selfPid: 1, alive: () => false, helpers: new Map(), home: '/home/u' }

describe('structuredRelayOwner', () => {
  test('reads the served session from the relay\'s own argument, every generation', () => {
    expect(structuredRelayOwner(['/usr/bin/agentop', '__structured-relay', '/home/u/.agentistics/structured/ee6debf036'])).toBe('ee6debf036')
    expect(structuredRelayOwner(['/usr/bin/agentop', '__structured-relay', '/home/u/.agentistics/structured/ee6debf036/g2'])).toBe('ee6debf036')
    expect(structuredRelayOwner(['/usr/bin/bun', 'run', '/r/packages/server/server/sessions/structured-relay.ts', '/tmp/x/structured/m-1'])).toBe('m-1')
  })
  test('nothing for anything else', () => {
    expect(structuredRelayOwner(['/usr/bin/agentop', '__structured-relay'])).toBeNull()
    expect(structuredRelayOwner(['/usr/bin/agentop', 'mcp'])).toBeNull()
    expect(structuredRelayOwner(['/usr/bin/agentop', '__structured-relay', '/tmp/other'])).toBeNull()
  })
})

describe('a relay in the inventory (03/11: a LIVE leader\'s relay listed as "<conv> — encerrado")', () => {
  // Started by a CLI inside session c8c43867: it inherited that session's CLAUDE_PID and marker.
  const relay = entry({
    argv: ['/usr/bin/agentop', '__structured-relay', '/home/u/.agentistics/structured/ee6debf036'],
    env: { CLAUDE_PID: '4242', CLAUDE_CODE_SESSION_ID: 'c8c43867-0000', AGENTOP_MANAGED_ID: 'starter01', HOME: '/home/u' },
  })
  test('is owned by the session in its argument, never by the inherited one', () => {
    const [p] = buildInventory([relay], ctx)
    expect(p!.managedId).toBe('ee6debf036')
    expect(p!.owner).toEqual({ kind: 'relay', pid: 10, sessionId: 'ee6debf036', alive: true })
  })
  test('detached by design: a parent of 1 is not "orphaned"', () => {
    expect(buildInventory([relay], ctx)[0]!.orphanWhy).toBeUndefined()
  })
  test('under an isolated (test) HOME the inherited owner is kept, so a leaked test relay is still retired', () => {
    const [p] = buildInventory([{ ...relay, env: { ...relay.env, HOME: '/tmp/run-x' } }], { ...ctx, tempRoots: ['/tmp/'] })
    expect(p!.owner?.kind).toBe('session')
    expect(p!.managedId).toBe('ee6debf036')
  })
})
