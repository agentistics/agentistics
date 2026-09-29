/**
 * tools/result/submit.ts — `result.submit`: how a run required to return a structured value hands it
 * back (TOOL.1, spec 2026-09-28-runtime-planning-orchestration-artifacts.md §6.1).
 *
 * ## A tool, and not provider-native structured output
 *
 * Providers differ in what they offer and the retry has to be OBSERVABLE: every attempt is a call the
 * gate journals (`tool.requested` → `tool.completed | tool.failed`) plus a `structured.attempt` the
 * loop writes, tied to the billed response it came in. A provider's own JSON mode retries (or does
 * not) where nobody can see it.
 *
 * ## It has no host power, and that is declared rather than promised
 *
 * `subjects()` is `[]` for every input — the tool touches no path, runs no command, asks nobody. The
 * policy treats an empty subject list as a call judged by its class alone, and the class is `auto`.
 * Its `run` only validates the value against the compiled schema and returns the verdict to the loop
 * through `ToolOutcome.result`; the value never leaves the return channel.
 * `structured-submit.lint.test.ts` holds both claims over the source and over the tool table.
 *
 * ## Only the loop builds it
 *
 * The loop adds this tool to a run's catalogue when (and only when) the run was given a `structured`
 * request, built from the schema that request already compiled. It is deliberately absent from
 * `createNativeTools`: a model offered `result.submit` in a run nobody asked a value of would be
 * invited to end work by a door that leads nowhere.
 */

import type { PolicySubject, Tool } from '../contract.ts'
import { defineTool } from '../define.ts'
import { formatValidationErrors, validate, type Schema, type ValidationError } from '../../structured/schema.ts'

export const RESULT_SUBMIT_TOOL = 'result.submit'

/** The verdict `run` hands the loop through `ToolOutcome.result`. */
export type SubmitVerdict =
  | { kind: 'result.submit'; accepted: true; value: unknown }
  | { kind: 'result.submit'; accepted: false; errors: ValidationError[] }

export function isSubmitVerdict(x: unknown): x is SubmitVerdict {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === RESULT_SUBMIT_TOOL
    && typeof (x as { accepted?: unknown }).accepted === 'boolean'
}

/** No effects, for every input. A frozen constant so no call can grow it. */
export const RESULT_SUBMIT_SUBJECTS: readonly PolicySubject[] = Object.freeze([])

export function createResultSubmitTool(schema: Schema): Tool<{ value: unknown }> {
  return defineTool<{ value: unknown }>({
    name: RESULT_SUBMIT_TOOL,
    description:
      'Submit the final result of this run as `value`. It must match the JSON schema given for ' +
      '`value` exactly; if it does not, you are told every place it departs from the schema and may ' +
      'submit again a limited number of times. Submitting a valid value ends the run.',
    kind: 'other',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      // The compiled schema IS a JSON Schema (a strict subset), so the provider can show it as-is.
      properties: { value: schema as Record<string, unknown> },
      required: ['value'],
      additionalProperties: false,
    },
    parse(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return 'result.submit expects an object with a `value` field.'
      }
      if (!Object.hasOwn(input, 'value')) return 'result.submit expects a `value` field holding the result.'
      const extra = Object.keys(input).filter(k => k !== 'value')
      if (extra.length > 0) return `result.submit takes only \`value\`; it was also sent ${extra.map(k => JSON.stringify(k)).join(', ')}.`
      return { value: (input as { value: unknown }).value }
    },
    subjects: async () => RESULT_SUBMIT_SUBJECTS,
    run: async ({ value }) => {
      const errors = validate(schema, value)
      if (errors.length === 0) {
        const result: SubmitVerdict = { kind: RESULT_SUBMIT_TOOL, accepted: true, value }
        return { ok: true, modelText: 'The value matches the schema and was accepted.', result }
      }
      const result: SubmitVerdict = { kind: RESULT_SUBMIT_TOOL, accepted: false, errors }
      const text =
        `The value does not match the required schema (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n` +
        `${formatValidationErrors(errors)}\nCorrect every problem and call result.submit again with the whole value.`
      return { ok: false, modelText: text, error: { class: 'invalid-input', detail: text }, result }
    },
  })
}
