import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, SPAWN_SPECS_MODEL_IDS } from '@agentistics/core'
import { SPAWN_SPECS, conversationLinkGoneForever, conversationLinkable, planSpawn } from './spawn-spec'

describe('SPAWN_SPECS', () => {
  it('has an entry for every harness', () => {
    for (const id of HARNESS_ORDER) {
      expect(SPAWN_SPECS).toHaveProperty(id)
    }
  })

  it('gives every spawnable harness a way to receive an initial prompt', () => {
    for (const id of HARNESS_ORDER) {
      const spec = SPAWN_SPECS[id]
      if (!spec) continue
      expect(spec.prompt.kind).toBeDefined()
      expect(spec.bin.length).toBeGreaterThan(0)
    }
  })

  it('only ever suggests a model name the harness itself printed', () => {
    // Not a taste rule: a suggestion is offered as a thing that WILL work, and the picker is a
    // closed dropdown, so an id the CLI refuses fails at spawn with nothing on screen to explain
    // it. Every list below was read back from that tool on 2026-09-02 (versions and the exact
    // commands are recorded per harness in spawn-spec.ts); the EMPTY ones are the harnesses whose
    // CLI publishes no list at all, and empty is what makes the picker absent instead of wrong.
    expect(SPAWN_SPECS.claude?.modelSuggestions).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(SPAWN_SPECS.copilot?.modelSuggestions).toEqual(['auto'])
    expect(SPAWN_SPECS.antigravity?.modelSuggestions).toContain('gemini-3.6-flash-high')
    for (const id of ['codex', 'gemini', 'kimi'] as const) {
      expect(SPAWN_SPECS[id]?.modelSuggestions).toEqual([])
    }
  })

  it('never suggests a model id the CLI was measured to REFUSE', () => {
    // Each of these was shipped here at some point and each was rejected when actually run:
    // `mythos` is in claude's own tier-name regex and not in its catalog; the copilot pair (and
    // `gpt-5.4`, copilot's own help example) come back "not available"; `gemini-2.5-pro` is "no
    // longer available to new users"; and agy's bare `gemini-3.6-flash` is a REPORTED id, not a
    // `--model` value. Pinned so none of them can drift back in from memory.
    const refused = [
      'mythos',
      'claude-sonnet-4.6', 'gpt-5.3-codex', 'gpt-5.4',
      'gemini-2.5-pro',
      'gemini-3.6-flash',
    ]
    for (const id of HARNESS_ORDER) {
      for (const model of SPAWN_SPECS[id]?.modelSuggestions ?? []) {
        expect(refused).not.toContain(model)
      }
    }
  })

  it('suggests names verbatim — no labels, no duplicates, no padding', () => {
    // The same string is typed at `--model` on spawn AND after `/model` mid-conversation, and both
    // match the id exactly. A prettified "Opus 5" is not a failure the user sees: the slash command
    // answers "not found" inside the session and the switch silently does nothing.
    for (const id of HARNESS_ORDER) {
      const models = SPAWN_SPECS[id]?.modelSuggestions ?? []
      expect(new Set(models).size).toBe(models.length)
      for (const model of models) {
        expect(model).toBe(model.trim())
        expect(model.length).toBeGreaterThan(0)
        expect(model).not.toMatch(/\s/)
      }
    }
  })

  it('never offers a model to a harness that has no flag to pass it through', () => {
    for (const id of HARNESS_ORDER) {
      const spec = SPAWN_SPECS[id]
      if (!spec || spec.modelFlag) continue
      expect(spec.modelSuggestions).toEqual([])
    }
  })

  it('never declares an effort flag without the enum that validates it', () => {
    // The two go together or neither is trustworthy: a flag with no accepted list would pass any
    // string through to a CLI that rejects it, which fails after the session has already started.
    for (const id of HARNESS_ORDER) {
      const spec = SPAWN_SPECS[id]
      if (!spec) continue
      expect(Boolean(spec.effortFlag)).toBe(Boolean(spec.efforts?.length))
    }
  })
})

describe('planSpawn', () => {
  it('puts a claude prompt in the positional slot, after the flags, and marks it for submit', () => {
    // Positional, so the text is in argv — but the backend must still SUBMIT it (an Enter) on a
    // version that pre-fills without auto-submitting, without double-submitting one that does.
    const r = planSpawn({ harness: 'claude', cwd: '/tmp', prompt: 'fix the tests', model: 'opus', effort: 'high' })
    expect(r).toEqual({
      ok: true,
      plan: { argv: ['claude', '--model', 'opus', '--effort', 'high', 'fix the tests'], initialPrompt: { mode: 'submit' } },
    })
  })

  it('puts a codex prompt in the positional slot and marks it for submit', () => {
    const r = planSpawn({ harness: 'codex', cwd: '/tmp', prompt: 'implement X', model: 'o3' })
    expect(r).toEqual({
      ok: true,
      plan: { argv: ['codex', '--no-daemon', '--model', 'o3', 'implement X'], initialPrompt: { mode: 'submit' } },
    })
  })

  it('kimi 2.1.1 resumes by the session DIRECTORY name: the bare uuid the store keys on gets its `session_` prefix, once', () => {
    const uuid = '7b280b0b-d8ae-4922-b165-07dc06f3c909'
    for (const id of [uuid, `session_${uuid}`]) {
      const r = planSpawn({ harness: 'kimi', cwd: '/tmp', resumeId: id })
      expect(r).toMatchObject({ ok: true, plan: { argv: ['kimi', '-S', `session_${uuid}`] } })
    }
  })

  it('types a kimi prompt in, because kimi has no interactive prompt flag', () => {
    const r = planSpawn({ harness: 'kimi', cwd: '/tmp', prompt: 'implement X' })
    expect(r).toEqual({ ok: true, plan: { argv: ['kimi'], initialPrompt: { mode: 'type', text: 'implement X' } } })
  })

  it('omits the prompt entirely when there is none', () => {
    const r = planSpawn({ harness: 'claude', cwd: '/tmp' })
    expect(r).toEqual({ ok: true, plan: { argv: ['claude'] } })
  })

  it('refuses an effort value the harness does not accept, naming the ones it does', () => {
    const r = planSpawn({ harness: 'claude', cwd: '/tmp', effort: 'ultra' })
    expect(r).toEqual({
      ok: false,
      error: { code: 'unknown-effort', harness: 'claude', value: 'ultra', accepted: ['low', 'medium', 'high', 'xhigh', 'max'] },
    })
  })

  it('refuses effort for a harness that has none rather than inventing a flag', () => {
    const r = planSpawn({ harness: 'kimi', cwd: '/tmp', effort: 'high' })
    expect(r).toEqual({ ok: false, error: { code: 'effort-unsupported', harness: 'kimi' } })
  })

  it('passes a gemini prompt through the flag that stays interactive', () => {
    // `--prompt-interactive` rather than the positional `query`: both stay interactive today, but
    // only one says so in its own name, and a positional that silently goes headless is a trap.
    const r = planSpawn({ harness: 'gemini', cwd: '/tmp', prompt: 'find the leak' })
    expect(r).toEqual({ ok: true, plan: { argv: ['gemini', '--prompt-interactive', 'find the leak'] } })
  })

  it('types a copilot prompt in, because its -p exits after answering', () => {
    const r = planSpawn({ harness: 'copilot', cwd: '/tmp', prompt: 'review this' })
    expect(r).toEqual({ ok: true, plan: { argv: ['copilot'], initialPrompt: { mode: 'type', text: 'review this' } } })
  })

  it('accepts agy effort, which its own --help prints as a closed set', () => {
    const r = planSpawn({ harness: 'antigravity', cwd: '/tmp', effort: 'high' })
    expect(r).toEqual({ ok: true, plan: { argv: ['agy', '--effort', 'high'] } })
  })

  it('accepts agy 1.3.2\'s two extra levels, xhigh and max (P-23)', () => {
    for (const effort of ['xhigh', 'max']) {
      expect(planSpawn({ harness: 'antigravity', cwd: '/tmp', effort })).toEqual({ ok: true, plan: { argv: ['agy', '--effort', effort] } })
    }
  })

  it('refuses an agy effort outside that set', () => {
    const r = planSpawn({ harness: 'antigravity', cwd: '/tmp', effort: 'extreme' })
    expect(r).toEqual({
      ok: false,
      error: { code: 'unknown-effort', harness: 'antigravity', value: 'extreme', accepted: ['low', 'medium', 'high', 'xhigh', 'max'] },
    })
  })

  it('refuses effort for gemini, which has no such flag', () => {
    const r = planSpawn({ harness: 'gemini', cwd: '/tmp', effort: 'high' })
    expect(r).toEqual({ ok: false, error: { code: 'effort-unsupported', harness: 'gemini' } })
  })

  it('does NOT validate the model against a closed list', () => {
    const r = planSpawn({ harness: 'claude', cwd: '/tmp', model: 'claude-opus-5-some-future-name' })
    expect(r).toEqual({ ok: true, plan: { argv: ['claude', '--model', 'claude-opus-5-some-future-name'] } })
  })
})

describe('assigning the conversation id at spawn', () => {
  it('names the conversation for a harness whose CLI accepts one', () => {
    // claude: `--session-id <uuid>  Use a specific session ID for the conversation`. Verified on
    // 2026-08-14 to produce `~/.claude/projects/<enc>/<uuid>.jsonl` — the same id the adapter reads
    // back, which is what makes recording it worth anything.
    const r = planSpawn({ harness: 'claude', cwd: '/r', conversationId: 'u-1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.argv).toEqual(['claude', '--session-id', 'u-1'])
    expect(r.plan.conversationId).toBe('u-1')
  })

  it('does the same for copilot, whose single flag both sets and resumes', () => {
    const r = planSpawn({ harness: 'copilot', cwd: '/r', conversationId: 'u-2' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.argv).toEqual(['copilot', '--session-id', 'u-2'])
    expect(r.plan.conversationId).toBe('u-2')
  })

  it('records NOTHING for a harness that invents its own id and never reports it', () => {
    // codex, kimi and antigravity. An id recorded here would be one nothing in the store
    // resolves to, which is worse than none: it LOOKS like an exact link. They are linked another
    // way instead — see `conversationLinkable`.
    for (const harness of ['codex', 'kimi', 'antigravity'] as const) {
      const r = planSpawn({ harness, cwd: '/r', conversationId: 'u-3' })
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.plan.argv).not.toContain('u-3')
      expect(r.plan.conversationId).toBeUndefined()
    }
  })

  it('assigns the id to gemini through --session-id, and records it', () => {
    // gemini 0.63.0, VERIFIED LIVE 2026-10-09: `gemini --session-id <uuid>` wrote a chat whose
    // header `sessionId` is that uuid and whose file name ends in its first eight characters. The
    // store keys the chat by `<project>/<file>`, bridged by `SessionMeta.native_session_id`.
    const id = '04d97770-e53f-4b7d-86d2-63bd12ec32eb'
    const r = planSpawn({ harness: 'gemini', cwd: '/r', conversationId: id, prompt: 'hi' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.argv).toEqual(['gemini', '--session-id', id, '--prompt-interactive', 'hi'])
    expect(r.plan.conversationId).toBe(id)
  })

  it('never assigns an id beside a resume — that conversation already has one', () => {
    const r = planSpawn({ harness: 'claude', cwd: '/r', resumeId: 'old', conversationId: 'new' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.argv).toEqual(['claude', '--resume', 'old'])
    // The conversation this spawn drives is the one it was told to reopen.
    expect(r.plan.conversationId).toBe('old')
  })

  it('leaves the argv untouched when no id is offered', () => {
    const r = planSpawn({ harness: 'claude', cwd: '/r' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.argv).toEqual(['claude'])
    expect(r.plan.conversationId).toBeUndefined()
  })
})

describe('conversationLinkable', () => {
  it('is true exactly where an EXACT link can exist', () => {
    // claude on both counts (`--session-id`, and `~/.claude/sessions/<pid>.json` carrying the tmux
    // session we started it under); copilot on the flag alone.
    expect(conversationLinkable('claude')).toBe(true)
    expect(conversationLinkable('copilot')).toBe(true)
    // antigravity on a third: it has NO assign flag (`--conversation` resumes and refuses an
    // unknown id — measured against agy 1.1.27) and writes no session record, but it holds its own
    // per-process log open, and that log names the conversation it created. See
    // `agy-conversation.ts`; the chain pid -> fd -> log -> conversation is exact at every step.
    expect(conversationLinkable('antigravity')).toBe(true)
    // codex and kimi on the same third route, read by NAME: codex's native binary holds
    // `thread-writer-locks/<id>.lock` and `rollout-…-<id>.jsonl`, kimi opens `session_<id>/…` while
    // writing (measured 2026-10-08, `process-transcript.ts`).
    expect(conversationLinkable('codex')).toBe(true)
    expect(conversationLinkable('kimi')).toBe(true)
  })

  it('is false where every answer would be a harness-and-directory guess', () => {
    // The guess gives every session of one repository the same conversation — the bug that reopened
    // three rows onto one conversation. It is fine to OFFER, and this flag is what stops it being
    // presented as the conversation the row is in. opencode has no spawn spec at all.
    expect(conversationLinkable('opencode')).toBe(false)
  })

  it('is true for gemini, which is handed its id at spawn (F0.2)', () => {
    expect(conversationLinkable('gemini')).toBe(true)
  })
})

describe('conversationLinkGoneForever', () => {
  it('keeps agy recoverable after exit because its managed log outlives the process', () => {
    expect(conversationLinkGoneForever('antigravity')).toBe(false)
  })

  it('is false for a harness with an assign flag or a session-file route', () => {
    // claude and copilot record the link at spawn (or while the harness's own file exists) through a
    // mechanism that has nothing to do with the process's own open fd — an ended, unlinked session of
    // either is a different fact (or, for claude, cannot happen at all) and this function is not the
    // one that answers it.
    expect(conversationLinkGoneForever('claude')).toBe(false)
    expect(conversationLinkGoneForever('copilot')).toBe(false)
  })

  it('is false for a harness that was never linkable in the first place', () => {
    // opencode is `!conversationLinkable` already — `sessConversationBlind` names that, and this
    // function exists for the narrower, DIFFERENT case: a harness that CAN link, in principle, but
    // only within a window that has closed.
    expect(conversationLinkGoneForever('opencode')).toBe(false)
  })

  it('is false for codex and kimi, whose process route is not their ONLY route', () => {
    // An ended, unlinked codex or kimi conversation is still claimed by first sighting once it is in
    // the store — slower, and refused on a shared folder, but not gone.
    expect(conversationLinkGoneForever('codex')).toBe(false)
    expect(conversationLinkGoneForever('kimi')).toBe(false)
  })
})

it('offers exactly the ids harnessModels names, so the picker and the flag agree', () => {
  for (const [harness, spec] of Object.entries(SPAWN_SPECS)) {
    if (!spec) continue
    expect(spec.modelSuggestions ?? [], harness).toEqual(
      SPAWN_SPECS_MODEL_IDS[harness as keyof typeof SPAWN_SPECS_MODEL_IDS] ?? [],
    )
  }
})

/**
 * A DEFAULT MAY NOT EXIST WITHOUT PROVENANCE, and today none of the six CLIs publishes one.
 *
 * The test is here so that filling either field is a deliberate act with a command behind it —
 * exactly the `MODEL_PRICING` / `ContextWindow` rule applied to a third number. Measured
 * 2026-09-04 against claude 2.1.261, codex-cli 0.113.0, gemini 0.55.1, copilot 1.0.82,
 * agy 1.1.25 and kimi 0.38.0; the defaults block in `spawn-spec.ts` records what was run.
 */
it('claims no default model or effort, because no CLI publishes one', () => {
  for (const [harness, spec] of Object.entries(SPAWN_SPECS)) {
    if (!spec) continue
    expect(spec.defaultModel, `${harness} defaultModel`).toBeUndefined()
    expect(spec.defaultEffort, `${harness} defaultEffort`).toBeUndefined()
  }
})

it('never pairs a default with a flag the CLI does not have', () => {
  // A `defaultEffort` on a harness with no `--effort` would be a sentence about a question the
  // wizard never asks — the same shape as reporting "Model: default" where there is no model flag.
  for (const [harness, spec] of Object.entries(SPAWN_SPECS)) {
    if (!spec) continue
    if (spec.defaultModel !== undefined) expect(spec.modelFlag, harness).toBeDefined()
    if (spec.defaultEffort !== undefined) expect(spec.effortFlag, harness).toBeDefined()
  }
})

describe('exclusive managed process log', () => {
  it('agy receives the log override on a fresh spawn and on reopen', () => {
    for (const resumeId of [undefined, 'existing-conversation']) {
      const r = planSpawn({ harness: 'antigravity', cwd: '/r', logFile: '/data/agy-logs/0123456789.log', ...(resumeId ? { resumeId } : {}) })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan.argv).toContain('--log-file')
        expect(r.plan.argv).toContain('/data/agy-logs/0123456789.log')
        expect(r.plan.conversationId).toBe(resumeId)
        if (resumeId) expect(r.plan.argv.slice(1, 3)).toEqual(['--conversation', resumeId])
      }
    }
  })
  it('leaves every other harness argv unchanged', () => {
    for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'opencode'] as const) {
      expect(planSpawn({ harness, cwd: '/r', logFile: '/data/agy-logs/0123456789.log' }))
        .toEqual(planSpawn({ harness, cwd: '/r' }))
    }
  })
})


describe('reopening a gemini conversation by id (F0.2)', () => {
  const id = '04d97770-e53f-4b7d-86d2-63bd12ec32eb'

  it('passes the uuid to --resume, which the CLI accepts beside "latest" and an index', () => {
    // VERIFIED LIVE 2026-10-09, gemini 0.63.0: `--resume <uuid>` reopened the conversation (the
    // model recalled the earlier turn, one chat file) and an unknown uuid was refused by the CLI.
    const r = planSpawn({ harness: 'gemini', cwd: '/r', resumeId: id })
    expect(r).toEqual({ ok: true, plan: { argv: ['gemini', '--resume', id], conversationId: id } })
  })

  it('REFUSES an old synthetic <project>/<file> id instead of launching a CLI that fails unseen', () => {
    const r = planSpawn({ harness: 'gemini', cwd: '/r', resumeId: 'work/session-2026-10-09T10-49-04d97770' })
    expect(r).toEqual({
      ok: false,
      error: { code: 'resume-id-unusable', harness: 'gemini', id: 'work/session-2026-10-09T10-49-04d97770' },
    })
  })

  it('does not refuse an id for a harness that declares no restriction', () => {
    expect(planSpawn({ harness: 'claude', cwd: '/r', resumeId: 'anything' }).ok).toBe(true)
  })
})
