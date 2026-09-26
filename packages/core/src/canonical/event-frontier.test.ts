/**
 * event-frontier.test.ts — the §38 "Journal ⊅ instruction" boundary, asserted over module source.
 *
 * This is the review gate for anything added to `event.ts`'s canonical event union: a new field or
 * a new string literal that fails one of the checks below is a product decision, not a drive-by. It
 * uses the same technique `events-frontier.test.ts` already uses for the notification channel
 * (greps over the SOURCE, not behaviour — a test that only exercised behaviour would pass the day
 * somebody adds an `action` field nothing reads yet) and the comment-stripping approach
 * `shell-isolation.test.ts` uses so the module's own PROSE (which is required to explain the rule
 * in words) never trips the lint meant for CODE.
 *
 * `entities.ts` is deliberately NOT scanned here: `SideProcess.command` is the entity field §13.4
 * names (a command, summarised) and lives on the domain model, not on the event envelope — the
 * EVENT that carries the same fact names it `summary` (`ProcessStartedData.summary`), which is
 * exactly the frontier this file exists to hold.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentisticsEvent, EventProvenance } from './event'

const here = (f: string): string => readFileSync(join(import.meta.dir, f), 'utf8')

/**
 * Strip block and line comments — the same approach `shell-isolation.test.ts` uses. `event.ts`'s
 * own header is REQUIRED to explain this rule in prose (it says "instruction", "action" and
 * "command" in its doc comments), so scanning raw source would fail on the module explaining
 * itself rather than on a real violation.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * The checker under test, extracted as a function so it can be run both over the real module
 * source AND over inline strings in the self-test below — a lint that is only ever exercised
 * against a file that already passes proves nothing about whether it can fail.
 *
 * Returns the list of forbidden property names found as declared keys (`name?:` / `name:` /
 * `'name':`) in the given (already comment-stripped) source.
 */
const FORBIDDEN_PROPS = [
  // §38's own set
  'action', 'command', 'instruction',
  // the notification channel's set (events-frontier.test.ts), unioned in per the task
  'suggest', 'respondWith', 'reply', 'approve', 'answer',
  'run', 'exec', 'script',
]

function forbiddenPropertyHits(strippedSrc: string): string[] {
  const hits: string[] = []
  for (const forbidden of FORBIDDEN_PROPS) {
    // Plain identifier key: `  name?:` or `  name:` at the start of a line (allowing indentation).
    if (new RegExp(`^\\s*${forbidden}\\??:`, 'm').test(strippedSrc)) hits.push(forbidden)
    // Quoted key: `'name':` or `"name":`.
    else if (new RegExp(`['"]${forbidden}['"]\\s*\\??:`, 'm').test(strippedSrc)) hits.push(forbidden)
  }
  return hits
}

/**
 * A string literal that is a SENTENCE (contains whitespace) rather than an identifier-like token.
 * A fact vocabulary — event type names, statuses, kinds — is made of short tokens
 * (`'model.completed'`, `'killed-by-runtime'`); a literal with a space in it is prose, and prose in
 * a *type* (not a runtime string the harness produced) is exactly how an instruction sneaks in as
 * a default value or an example.
 */
const TOKEN_LITERAL = /^[a-z0-9][a-z0-9._-]*$/i

function stringLiteralsIn(strippedSrc: string): string[] {
  const out: string[] = []
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(strippedSrc)) !== null) {
    const lit = m[1] ?? m[2] ?? m[3] ?? ''
    out.push(lit)
  }
  return out
}

function imperativeSentenceLiterals(strippedSrc: string): string[] {
  return stringLiteralsIn(strippedSrc).filter(lit => lit.length > 0 && !TOKEN_LITERAL.test(lit))
}

describe('the canonical event union carries facts, never an instruction (§38)', () => {
  /**
   * Scanned from the first `export` onward, so the header's own prose (which must say "action",
   * "command" and "instruction" in words to explain the rule) is never read — only the exported
   * TYPES that would actually reach a consumer.
   */
  function moduleUnderTest(): string {
    const src = here('event.ts')
    const from = src.indexOf('export ')
    expect(from).toBeGreaterThanOrEqual(0)
    return stripComments(src.slice(from))
  }

  test('no forbidden property name appears as a declared key', () => {
    const hits = forbiddenPropertyHits(moduleUnderTest())
    expect(hits).toEqual([])
  })

  test('every string literal in the module is a short token, never an imperative sentence', () => {
    const hits = imperativeSentenceLiterals(moduleUnderTest())
    expect(hits).toEqual([])
  })

  test('entities.ts is deliberately NOT scanned: SideProcess.command is the entity field, summary is the event field', () => {
    // Stated positively rather than skipped silently: a future edit that starts scanning
    // entities.ts too would immediately fail on `command: string` there, which is correct per
    // §13.4 and would need a deliberate carve-out, not an accidental one.
    const entitiesSrc = here('entities.ts')
    expect(entitiesSrc).toContain('command: string')
    // The EVENT side never repeats that name.
    const eventSrc = moduleUnderTest()
    expect(forbiddenPropertyHits(eventSrc)).not.toContain('command')
  })
})

describe('the envelope shape, stated positively', () => {
  test('AgentisticsEvent carries exactly these top-level keys', () => {
    const shape: Record<keyof AgentisticsEvent, true> = {
      eventId: true,
      schema: true,
      type: true,
      occurredAt: true,
      recordedAt: true,
      sessionId: true,
      runId: true,
      agentId: true,
      taskId: true,
      source: true,
      provenance: true,
      data: true,
    }
    expect(Object.keys(shape).sort()).toEqual(
      [
        'agentId', 'data', 'eventId', 'occurredAt', 'provenance', 'recordedAt', 'runId', 'schema',
        'sessionId', 'source', 'taskId', 'type',
      ].sort(),
    )
  })

  test('provenance carries exactly mode, confidence, adapterVersion, sourceRef — mode and confidence SEPARATE (§14 rule 3)', () => {
    const shape: Record<keyof EventProvenance, true> = {
      mode: true,
      confidence: true,
      adapterVersion: true,
      sourceRef: true,
    }
    expect(Object.keys(shape).sort()).toEqual(['adapterVersion', 'confidence', 'mode', 'sourceRef'].sort())
  })
})

describe('self-test: the lint actually bites', () => {
  test('a forbidden property name is reported', () => {
    const src = stripComments('export interface X {\n  command?: string\n}\n')
    expect(forbiddenPropertyHits(src)).toEqual(['command'])
  })

  test('a quoted forbidden key is reported too', () => {
    const src = stripComments("export interface X {\n  'action': string\n}\n")
    expect(forbiddenPropertyHits(src)).toEqual(['action'])
  })

  test('an imperative sentence literal is reported', () => {
    const src = stripComments("export const X = 'Run the tests now'\n")
    expect(imperativeSentenceLiterals(src)).toEqual(['Run the tests now'])
  })

  test('a fact-shaped token literal is NOT reported', () => {
    const src = stripComments("export const X = 'model.completed'\n")
    expect(imperativeSentenceLiterals(src)).toEqual([])
  })

  test('a real occurrence would fail the actual module test — proven by re-running the exact check used above', () => {
    // A minimal stand-in for event.ts carrying a violation of BOTH rules, run through the SAME
    // functions the module test above calls — so this is not a second, looser implementation of
    // the lint that could drift from the one actually guarding event.ts.
    const poisoned = stripComments(`
      export interface PoisonedData {
        command?: string
        note: 'Please approve this now'
      }
    `)
    expect(forbiddenPropertyHits(poisoned)).toContain('command')
    expect(imperativeSentenceLiterals(poisoned)).toContain('Please approve this now')
  })

  test('a comment mentioning a forbidden word does not trip the property-name check', () => {
    const src = stripComments('// this module must never carry a field named command\nexport interface X {\n  summary?: string\n}\n')
    expect(forbiddenPropertyHits(src)).toEqual([])
  })
})
