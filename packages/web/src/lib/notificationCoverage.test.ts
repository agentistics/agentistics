import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { NOTIFICATION_TEXT, resolveNotification } from './notifications'

/**
 * EVERY CODE THE SERVER CAN EMIT HAS TEXT ON BOTH SIDES.
 *
 * Reported as blank notification cards: an icon, a timestamp, a dismiss button and nothing to read.
 * Only `code` + `meta` are ever stored — deliberately, so switching the language re-translates —
 * so a code this table has not met is a card that says an event happened and refuses to say what.
 *
 * A grep over the SERVER's own source, in the shape `tokens.lint.test.ts` uses: the check is that
 * the two halves cannot drift, and the only way to hold that is to read the half that emits.
 */
const SERVER = join(import.meta.dir, '../../../server/server')

/** Codes that appear only inside tests and fixtures — they are not events this product raises. */
// Pure retire-plan result/reason codes: never broadcast as notification codes.
// retirePredecessor refusal codes: returned to the calling tool (session-roles.ts), never notified.
const PLAN_CODES = new Set([
  'handoff_pending', 'working',
  'not_own', 'not_leader_target', 'different_task', 'not_live', 'no_task', 'self', 'no_such_session', 'not_wired', 'dirty_worktrees',
  // DSL.TIPO-SESSAO spawn-gate refusals: returned to the spawning door in plain words, never notified.
  'gate_failed', 'gate_refused',
])

const FIXTURES = new Set(['a', 'b', 'c', 'x', 'custom', 'ambiguous', 'missing_field', 'some.new_code_nobody_scoped'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const emitted = (): Set<string> => {
  const found = new Set<string>()
  for (const file of walk(SERVER)) {
    const source = readFileSync(file, 'utf8')
    // The retire runner passes its code as notify's fourth argument. Cover that emitter too.
    for (const pattern of [/\bcode: '([a-z][a-z_.]*)'/g, /\bnotify\([^,\n]+,[^,\n]+,[^,\n]+,\s*'([a-z][a-z_.]*)'/g]) {
      for (const m of source.matchAll(pattern)) {
        if (!FIXTURES.has(m[1]!) && !PLAN_CODES.has(m[1]!)) found.add(m[1]!)
      }
    }
  }
  return found
}

describe('notification coverage', () => {
  it('plan codes do not ship unreachable notification copy', () => {
    for (const code of PLAN_CODES) {
      expect(emitted().has(code)).toBe(false)
      expect(NOTIFICATION_TEXT[code]).toBeUndefined()
    }
  })

  it('retire notifications are covered through the positional emitter', () => {
    for (const code of ['retire.done', 'retire.cancelled', 'retire.expired']) {
      expect(emitted().has(code)).toBe(true)
    }
  })

  // QA r2 F6: the delivery guard's refusals are returned by helpers (`fail(422, 'code', …)`, `bad('code', …)`) and typed in unions,
  // forms the `code: '…'` scanner above cannot see. They are enumerated here AND scanned out of the guard's own modules.
  const DELIVERY_REFUSALS = [
    'classification_required', 'uncommitted_changes', 'evidence_required', 'evidence_stale', 'evidence_invalid', 'evidence_reused',
    'declaration_invalid', 'declaration_unclassifiable', 'declaration_repo_unresolved', 'declaration_commit_missing', 'declaration_unpushed',
    'classify_unavailable', 'classify_leader_only',
  ]
  it('every delivery-guard refusal has EN and PT text, whatever syntax emits it', () => {
    const missing = DELIVERY_REFUSALS.filter(c => !NOTIFICATION_TEXT[c]?.en?.title || !NOTIFICATION_TEXT[c]?.pt?.title || !NOTIFICATION_TEXT[c]?.en?.message || !NOTIFICATION_TEXT[c]?.pt?.message)
    expect(missing).toEqual([])
  })
  it('...and every refusal literal in the guard\'s modules is in that list (a new code cannot be added silently)', () => {
    const dir = join(SERVER, 'delivery')
    const found = new Set<string>()
    for (const name of readdirSync(dir)) {
      if (!/^(classify|evidence)[a-z-]*\.ts$/.test(name) || name.endsWith('.test.ts') || name.endsWith('.testing.ts')) continue
      const src = readFileSync(join(dir, name), 'utf8')
      for (const m of src.matchAll(/'((?:classification|declaration|evidence|classify)_[a-z_]+|uncommitted_changes)'/g)) found.add(m[1]!)
    }
    expect([...found].filter(c => !DELIVERY_REFUSALS.includes(c) && !NOTIFICATION_TEXT[c])).toEqual([])
  })

  it('every code the server emits has EN and PT text', () => {
    const missing: string[] = []
    for (const code of [...emitted()].sort()) {
      const t = NOTIFICATION_TEXT[code]
      if (!t?.en?.title || !t?.pt?.title) missing.push(code)
    }
    expect(missing).toEqual([])
  })

  it('the server emits enough codes for this test to be worth anything', () => {
    // A guard on the guard: if the grep stops matching (the emit shape changed), the test above
    // passes vacuously and the next blank card ships.
    expect(emitted().size).toBeGreaterThan(15)
  })

  it('an UNKNOWN code still renders something a person can read', () => {
    // The lint can only see the codes this build emits. A notification stored by a newer build and
    // read by an older one is the case it cannot reach — and a blank card is the one outcome that
    // must be impossible.
    const out = resolveNotification(
      { id: '1', type: 'info', code: 'something.nobody.mapped', ts: 0, read: false },
      'en',
    )
    expect(out.title).toContain('something.nobody.mapped')
    expect(out.title.trim()).not.toBe('')
  })
})

describe('plan.segment', () => {
  it('names the harness in both languages and never renders blank', () => {
    const n = { id: 's', code: 'plan.segment', meta: { harness: 'codex', account: 'acc_x' }, type: 'info', at: 0, read: false }
    const en = resolveNotification(n as never, 'en')
    const pt = resolveNotification(n as never, 'pt')
    expect(en.title).toContain('Codex')
    expect(en.message).toContain('counting from zero')
    expect(pt.message).toContain('contando do zero')
    expect(`${en.message}${pt.message}`).not.toContain('acc_x')
  })
})
