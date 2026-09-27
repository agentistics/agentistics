/**
 * tools/interact/ask-user.ts — `ask.user`: the MODEL asking a PERSON (spec
 * docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3, §6, `contract.ts` `PersonAsker`).
 *
 * ## The tool never answers for a person
 *
 * There is no default option and no auto-choice. `PersonAnswer.answered === false` (the person never
 * responded — a timeout, a cancellation, or nobody able to reach them at all) is a FAILURE, reported
 * to the model in words with the matching `ToolErrorClass`, never silently treated as "no" or as the
 * first option. The three reasons the contract names (`timeout` | `cancelled` | `unavailable`) map
 * onto the catalogue's own error classes one for one (`timeout`, `killed`, `unavailable`) — `killed`
 * because a cancelled question is the same shape as a cancelled run, not a new class.
 *
 * ## No `asker` in context
 *
 * `ToolContext.asker` is absent whenever no person can be reached at all (a headless run, a CI
 * session). That is `unavailable` too, decided BEFORE ever touching `ctx.asker`, with a sentence
 * that tells the model what to do about it: proceed on its own judgement, or stop and say what it
 * needs — never silently skip the question.
 */

import type { PersonAnswer, PersonQuestion, PersonQuestionOption, PolicySubject, Tool, ToolErrorClass, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'

export interface AskUserOption {
  readonly label: string
  readonly description?: string
}

export interface AskUserInput {
  readonly question: string
  readonly options: readonly AskUserOption[]
  readonly allowFreeText?: boolean
}

const MIN_OPTIONS = 1
const MAX_OPTIONS = 6
const MAX_QUESTION_LEN = 2000
const MAX_LABEL_LEN = 200
const MAX_DESCRIPTION_LEN = 1000

/** `ask.user` touches nothing outside the run's own conversation with the person — one fixed subject. */
const ASK_USER_SUBJECTS: readonly PolicySubject[] = [{ action: 'ask-user' }]

const NO_ASKER_SENTENCE =
  'No person can be reached to answer this question right now. Proceed on your own best judgement, or stop and say what you need.'

function fail(cls: ToolErrorClass, sentence: string): ToolOutcome {
  return { ok: false, modelText: sentence, error: { class: cls, detail: sentence } }
}

function sentenceFor(reason: 'cancelled' | 'timeout' | 'unavailable'): { cls: ToolErrorClass; sentence: string } {
  switch (reason) {
    case 'timeout':
      return {
        cls: 'timeout',
        sentence: 'Nobody answered before the question timed out. Proceed on your own best judgement, or stop and say what you need.',
      }
    case 'cancelled':
      return { cls: 'killed', sentence: 'The question was cancelled before it was answered.' }
    case 'unavailable':
      return { cls: 'unavailable', sentence: NO_ASKER_SENTENCE }
  }
}

export function createAskUserTool(): Tool<AskUserInput> {
  return defineTool<AskUserInput>({
    name: 'ask.user',
    description:
      'Ask the person a short question with a list of options, and wait for their answer. Use this ' +
      'only when the next step genuinely depends on a choice only the person can make — it is a ' +
      'question to them, never a way to report your own progress.',
    kind: 'other',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: MAX_QUESTION_LEN },
        options: {
          type: 'array',
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', maxLength: MAX_LABEL_LEN },
              description: { type: 'string', maxLength: MAX_DESCRIPTION_LEN },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        allowFreeText: { type: 'boolean' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
    parse(input) {
      if (typeof input !== 'object' || input === null) {
        return 'ask.user expects an object with `question` and `options`.'
      }
      const question = (input as { question?: unknown }).question
      const rawOptions = (input as { options?: unknown }).options
      const allowFreeText = (input as { allowFreeText?: unknown }).allowFreeText

      if (typeof question !== 'string' || question.length === 0) return 'ask.user needs a non-empty `question`.'
      if (question.length > MAX_QUESTION_LEN) {
        return `The question is longer than the ${MAX_QUESTION_LEN}-character limit.`
      }
      if (!Array.isArray(rawOptions)) return 'ask.user needs an `options` array.'
      if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
        return `ask.user needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options; this call named ${rawOptions.length}.`
      }
      if (allowFreeText !== undefined && typeof allowFreeText !== 'boolean') {
        return '`allowFreeText` must be a boolean.'
      }

      const options: AskUserOption[] = []
      for (const [i, item] of rawOptions.entries()) {
        if (typeof item !== 'object' || item === null) return `Option ${i + 1} is not an object.`
        const label = (item as { label?: unknown }).label
        const description = (item as { description?: unknown }).description
        if (typeof label !== 'string' || label.length === 0) return `Option ${i + 1} needs a non-empty label.`
        if (label.length > MAX_LABEL_LEN) {
          return `Option ${i + 1}'s label is longer than the ${MAX_LABEL_LEN}-character limit.`
        }
        if (description !== undefined) {
          if (typeof description !== 'string') return `Option ${i + 1}'s description must be a string.`
          if (description.length > MAX_DESCRIPTION_LEN) {
            return `Option ${i + 1}'s description is longer than the ${MAX_DESCRIPTION_LEN}-character limit.`
          }
        }
        options.push(description === undefined ? { label } : { label, description })
      }

      return { question, options, allowFreeText: allowFreeText as boolean | undefined }
    },
    subjects: async () => ASK_USER_SUBJECTS,
    run: async (input, ctx) => {
      if (!ctx.asker) return fail('unavailable', NO_ASKER_SENTENCE)

      const options: PersonQuestionOption[] = input.options.map((o) =>
        o.description === undefined ? { label: o.label } : { label: o.label, description: o.description },
      )
      const question: PersonQuestion = {
        id: `${ctx.toolExecutionId}:q`,
        kind: 'question',
        text: input.question,
        options,
        allowFreeText: input.allowFreeText,
      }

      const answer: PersonAnswer = await ctx.asker.ask(question, ctx.signal)

      if (!answer.answered) {
        const { cls, sentence } = sentenceFor(answer.reason)
        return fail(cls, sentence)
      }

      if (answer.choice !== undefined) {
        if (answer.choice < 0 || answer.choice >= input.options.length || !Number.isInteger(answer.choice)) {
          return fail(
            'internal',
            `The person's answer named option ${answer.choice}, which is out of range for the ${input.options.length} offered here.`,
          )
        }
        const chosen = input.options[answer.choice] as AskUserOption
        const extra = answer.text ? ` They also added: "${answer.text}"` : ''
        return { ok: true, modelText: `The person chose: "${chosen.label}".${extra}` }
      }

      if (answer.text !== undefined && answer.text.length > 0) {
        return { ok: true, modelText: `The person answered: "${answer.text}"` }
      }

      return fail('internal', "The person's answer carried neither a chosen option nor free text.")
    },
  })
}
