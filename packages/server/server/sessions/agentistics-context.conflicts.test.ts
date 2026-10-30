import { describe, expect, test } from 'bun:test'
import { contextText, PRECEDENCE_LINE, type ContextInput } from './agentistics-context'
import { PLAN_LIMITS_TOOL } from '../briefing'

/**
 * Startup conflict test: the briefing is generated for every combination of state and must never
 * hold two instructions that contradict each other, nor the same paragraph twice. The forbidden
 * pairs live HERE, in the open — re-inserting one into the generator fails this file.
 */
const NOW = Date.parse('2026-10-12T05:00:00Z')
const AWAY = { on: true, since: '2026-10-12T02:00:00.000Z', until: '2026-10-12T12:00:00.000Z', authorised: ['releases' as const], maxWorkers: 6, topCaps: {} }
const base: ContextInput = { sessionId: 'abc123', cwd: '/w/proj', now: NOW, toolNames: [PLAN_LIMITS_TOOL] }

type Pair = { a: RegExp; b: RegExp; why: string }
/** Two sentences that may not stand in the same briefing. */
export const FORBIDDEN_PAIRS: Pair[] = [
  { a: /only after the user explicitly approves/, b: /pre-authorised within the away limits/, why: 'approval required vs pre-authorised' },
  { a: /never end a turn on a question/, b: /ASK the user|ask the user once|write the question in the conversation and wait/, why: 'never ask vs ask' },
  { a: /Never start, delegate to or orchestrate another session or harness on your own/, b: /Opening workers is pre-authorised/, why: 'cannot open vs may open' },
  { a: /Do not ask the owner/, b: /ASK the user whether|ask the user once|tell the user to open|Ask the person in the conversation|Pergunte à pessoa na conversa/, why: 'away told to ask' },
  { a: /Specification skills: do not ask/, b: /ASK the user whether to use a specification skill/, why: 'spec skill: ask vs do not ask' },
]
/** Sentences that may not appear at all in a given state. */
const NEVER_AWAY = [/only after the user explicitly approves/, /ASK the user whether to use a specification skill/, /ask the user once what plans/, /To ask the user something/, /Terminal" tab/]
const NEVER_WITH_BRIEF = [/ASK the user whether to use a specification skill/]
const NEVER_WORKER = [/Open other sessions/, /Opening workers is pre-authorised/, /Becoming leader/, /Model\/harness balance/, /read agentistics_plan_limits and follow its recommendation/]
const NEVER_ANY = [/150k/, /35%/]

const lines = (t: string) => t.split('\n').map(l => l.trim()).filter(Boolean)

describe('briefing conflict matrix', () => {
  for (const away of [false, true]) for (const role of ['leader', 'worker'] as const) for (const brief of [false, true]) for (const lang of ['en', 'pt'] as const) {
    const name = `${away ? 'away' : 'present'} × ${role} × ${brief ? 'brief' : 'no brief'} × ${lang}`
    const t = contextText({ ...base, role, lang, hasBrief: brief, ...(away ? { away: AWAY } : {}), ...(brief ? { parentId: 'p1' } : {}) })
    test(name, () => {
      for (const p of FORBIDDEN_PAIRS) expect(p.a.test(t) && p.b.test(t), p.why).toBe(false)
      for (const r of NEVER_ANY) expect(r.test(t), String(r)).toBe(false)
      if (away) for (const r of NEVER_AWAY) expect(r.test(t), `away: ${r}`).toBe(false)
      if (away || brief) for (const r of NEVER_WITH_BRIEF) expect(r.test(t), `brief: ${r}`).toBe(false)
      if (role === 'worker') for (const r of NEVER_WORKER) expect(r.test(t), `worker: ${r}`).toBe(false)
      // no repeated paragraph
      const ls = lines(t).filter(l => l.length >= 40)
      expect(ls.length).toBe(new Set(ls).size)
      // plan_limits paragraph at most once; precedence exactly once
      expect(t.split('agentistics_plan_limits and follow its recommendation').length - 1).toBeLessThanOrEqual(1)
      expect(t.split(PRECEDENCE_LINE).length - 1).toBe(1)
    })
  }
  test('detector fires: a forbidden pair re-inserted is caught', () => {
    const t = contextText({ ...base, role: 'leader', away: AWAY }) + '\nOpen other sessions only after the user explicitly approves: x'
    expect(FORBIDDEN_PAIRS.some(p => p.a.test(t) && p.b.test(t))).toBe(true)
    expect(NEVER_AWAY.some(r => r.test(t))).toBe(true)
    const dup = lines(t.concat('\n', t.split('\n')[1]!)).filter(l => l.length >= 40)
    expect(dup.length).not.toBe(new Set(dup).size)
  })
})
