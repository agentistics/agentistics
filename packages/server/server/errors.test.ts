import { describe, expect, it } from 'bun:test'
import { safeError } from './errors'
import { GuardBusy } from './delivery/guard-locks'

describe('safeError', () => {
  it('S2B-8 guard contention is a 409 code and EN/PT sentence for every transport', () => {
    const r = safeError(new GuardBusy('tasks'), { verbose: false }) as any
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'guard_busy', code: 'guard_busy' })
    expect(r.body.sentence).toContain('retry')
    expect(r.body.sentencePt).toContain('tente de novo')
  })
  it('returns a generic message and a correlation ref in production', () => {
    const r = safeError(new Error('ENOENT: /home/vini/.claude/secret.json'), { verbose: false })
    expect(r.body.error).toBe('internal_error')
    expect(r.body.ref).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(r.body)).not.toContain('/home/vini')
  })

  it('keeps the real message in the server-side log line, tied to the same ref', () => {
    const r = safeError(new Error('ENOENT: /home/vini/.claude/secret.json'), { verbose: false })
    expect(r.logLine).toContain('ENOENT')
    expect(r.logLine).toContain(r.body.ref)
  })

  it('echoes the message in verbose (local dev) mode', () => {
    expect(safeError(new Error('boom'), { verbose: true }).body.error).toBe('boom')
  })

  it('handles non-Error throws', () => {
    expect(safeError('a string', { verbose: false }).body.error).toBe('internal_error')
    expect(safeError(undefined, { verbose: true }).body.error).toBe('undefined')
  })

  it('gives every call a distinct ref', () => {
    const a = safeError(new Error('x'), { verbose: false })
    const b = safeError(new Error('x'), { verbose: false })
    expect(a.body.ref).not.toBe(b.body.ref)
  })
})
