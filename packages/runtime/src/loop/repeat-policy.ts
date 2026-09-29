/**
 * loop/repeat-policy.ts — the doom-loop guard's half that TALKS to a person (H18).
 *
 * When `./repeat-guard.ts` says a call is the Nth identical one in a row, the loop hands the gate
 * this policy instead of its own for that one call. It is a DECORATOR over the run's policy and it
 * can only make a call harder to run:
 *
 * - the run's policy is asked FIRST, exactly as it would have been; a `deny` is returned untouched
 *   (the guard never lifts a deny or a floor, and a refused call needs no second refusal);
 * - an `allow` is ESCALATED to a question — "the agent asked to run the same `shell.run` with the
 *   same input 3 times in a row" — with Allow once / Deny. No person, no answer, a timeout, an abort
 *   or an asker that throws is a DENY, the same rule the policy itself follows;
 * - an `allow` that the run's policy only reached by ASKING the person about this very call is
 *   returned as it is: the call was not going to run silently, and asking the person twice about one
 *   call is noise. The loop still counts that as the person having allowed the repeat.
 *
 * It sits between the gate and the policy — `runTool` still parses, states the subjects, journals
 * `policy.requested`/`policy.decided`, and mints the grant only on `allow`. Nothing here executes.
 *
 * The verdict's `policy` is `repeat-guard` whenever the guard itself decided, and a refusal carries
 * `code: policy.denied.repeat-guard` (or `policy.denied.aborted`, as the policy does) — the existing
 * `policy.denied` event already carries `code`, so the journal needs no new kind.
 */

import type { PersonAnswer, PersonAsker, PersonQuestion, PolicyRequest, PolicyVerdict, ToolPolicy } from '../tools/contract.ts'

export const REPEAT_GUARD_POLICY = 'repeat-guard'
export const REPEAT_GUARD_CODE = 'policy.denied.repeat-guard'

export interface RepeatGuardPolicy extends ToolPolicy {
  /** After `evaluate`: did a PERSON allow this call (the guard's question, or the policy's own)? */
  personAllowed(): boolean
}

/** What the person reads. */
export function repeatQuestionText(toolName: string, times: number): string {
  return [
    `The agent asked to run the same \`${toolName}\` with the same input ${times} times in a row, and the result did not change between the calls.`,
    '',
    'It may be stuck in a loop. Allow it to run once more?',
  ].join('\n')
}

type Refusal = 'no-person' | 'aborted' | 'failed' | 'timeout' | 'dismissed' | 'unavailable' | 'declined'

/** What the model reads when the repeat is refused. */
export function repeatRefusalSentence(toolName: string, times: number, why: Refusal): string {
  const head = `Not run: you asked to run the same \`${toolName}\` with the same input ${times} times in a row and the result did not change.`
  const tail: Record<Refusal, string> = {
    'no-person': 'A repeat like this needs a person\'s approval and no person was available, so it did not run.',
    aborted: 'The run was cancelled while the repeat was waiting for approval, so it did not run.',
    failed: 'The approval question could not be delivered to a person, so it did not run.',
    timeout: 'Nobody answered the approval question in time, so it did not run.',
    dismissed: 'The person dismissed the approval question, so it did not run.',
    unavailable: 'No person was available to approve the repeat, so it did not run.',
    declined: 'A person declined to let it run again.',
  }
  return `${head} ${tail[why]} Running it again will give the same answer; try something different.`
}

export function repeatGuardPolicy(base: ToolPolicy, times: number): RepeatGuardPolicy {
  let personAllowed = false

  const deny = (req: PolicyRequest, why: Refusal): PolicyVerdict => ({
    decision: 'deny',
    by: why === 'declined' || why === 'dismissed' ? 'user' : 'policy',
    policy: REPEAT_GUARD_POLICY,
    code: why === 'aborted' ? 'policy.denied.aborted' : REPEAT_GUARD_CODE,
    sentence: repeatRefusalSentence(req.call.toolName, times, why),
  })

  async function askPerson(req: PolicyRequest): Promise<PolicyVerdict> {
    if (req.signal?.aborted) return deny(req, 'aborted')
    if (!req.asker) return deny(req, 'no-person')
    const q: PersonQuestion = {
      id: `${req.call.toolExecutionId}:repeat-guard`,
      kind: 'permission',
      text: repeatQuestionText(req.call.toolName, times),
      options: [
        { label: 'Allow once', description: 'Run it this one more time.' },
        { label: 'Deny', description: 'Do not run it; the agent is told why.' },
      ],
      subjects: req.subjects,
    }
    let answer: PersonAnswer | 'aborted' | 'failed'
    try {
      const asked = req.asker.ask(q, req.signal)
      if (req.signal) {
        const signal = req.signal
        let onAbort: (() => void) | undefined
        const aborted = new Promise<'aborted'>(res => {
          onAbort = () => res('aborted')
          signal.addEventListener('abort', onAbort, { once: true })
        })
        answer = await Promise.race([asked, aborted])
        if (onAbort) signal.removeEventListener('abort', onAbort)
      } else {
        answer = await asked
      }
    } catch {
      answer = 'failed'
    }
    if (answer === 'aborted') return deny(req, 'aborted')
    if (answer === 'failed') return deny(req, 'failed')
    if (!answer.answered) {
      return deny(req, answer.reason === 'cancelled' ? 'dismissed' : answer.reason === 'timeout' ? 'timeout' : 'unavailable')
    }
    if (answer.choice === 0) {
      personAllowed = true
      return { decision: 'allow', by: 'user', policy: REPEAT_GUARD_POLICY }
    }
    return deny(req, 'declined')
  }

  return {
    personAllowed: () => personAllowed,
    async evaluate(req: PolicyRequest): Promise<PolicyVerdict> {
      personAllowed = false
      let innerAsked = false
      const asker: PersonAsker | undefined = req.asker && {
        ask: (q, signal) => { innerAsked = true; return req.asker!.ask(q, signal) },
      }
      const inner = await base.evaluate({ ...req, asker })
      if (inner.decision === 'deny') return inner
      if (innerAsked && inner.by === 'user') {
        personAllowed = true
        return inner
      }
      try {
        return await askPerson(req)
      } catch {
        return deny(req, 'failed')
      }
    },
  }
}
