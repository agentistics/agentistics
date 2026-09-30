/**
 * tools/testing.ts — offline doubles every B3 test shares: a scripted policy, a recording event
 * sink, an in-memory content store, a scripted person. Test-support only; exported from the package
 * because a HOST's tests (and the loop's) drive tools through the same gate.
 */

import { createHash } from 'node:crypto'
import type {
  ContentRef,
  ContentSink,
  PersonAnswer,
  PersonAsker,
  PersonQuestion,
  PolicyRequest,
  PolicyVerdict,
  ToolEventSink,
  ToolPolicy,
} from './contract.ts'

/** A policy that answers with a fixed decision (or a function of the request), and records asks. */
export function scriptedPolicy(
  answer: 'allow' | 'deny' | ((req: PolicyRequest) => PolicyVerdict),
): ToolPolicy & { seen: PolicyRequest[] } {
  const seen: PolicyRequest[] = []
  return {
    seen,
    async evaluate(req) {
      seen.push(req)
      if (typeof answer === 'function') return answer(req)
      return answer === 'allow'
        ? { decision: 'allow', by: 'policy', policy: 'test:allow' }
        : { decision: 'deny', by: 'policy', policy: 'test:deny', code: 'policy.denied.test', sentence: 'Refused by the test policy.' }
    },
  }
}

export type RecordedEvent = { event: keyof ToolEventSink } & Record<string, unknown>

export function recordingEvents(): ToolEventSink & { log: RecordedEvent[] } {
  const log: RecordedEvent[] = []
  const rec = (event: keyof ToolEventSink) => async (e: object) => { log.push({ ...e, event }) }
  return {
    log,
    requested: rec('requested'),
    policyRequested: rec('policyRequested'),
    policyDecided: rec('policyDecided'),
    completed: rec('completed'),
    failed: rec('failed'),
  }
}

export function memoryContent(): ContentSink & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async put(text): Promise<ContentRef> {
      const sha256 = createHash('sha256').update(text).digest('hex')
      store.set(sha256, text)
      return { sha256, bytes: Buffer.byteLength(text) }
    },
  }
}

export function scriptedAsker(answers: PersonAnswer[]): PersonAsker & { asked: PersonQuestion[] } {
  const asked: PersonQuestion[] = []
  return {
    asked,
    async ask(q) {
      asked.push(q)
      return answers.shift() ?? { answered: false, reason: 'unavailable' }
    },
  }
}
