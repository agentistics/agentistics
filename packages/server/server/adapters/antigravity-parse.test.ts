import { test, expect } from 'bun:test'
import {
  parseAntigravityHistory,
  buildAntigravityWorkspaceMap,
  parseAntigravityTranscript,
  extractUserRequest,
  collectSubagentChildIds,
  buildAntigravityChildSet,
  buildAntigravityParentMap,
  parseAntigravityTranscriptDetailed,
  rollUpAntigravitySessions,
  fileUriToPath,
  managedAntigravityCwds,
  projectFolderFromContext,
  type AntigravityTokenTotals,
} from './antigravity-parse'
import { contextBlock } from '../sessions/agentistics-context'
import { calcCost, sessionModelUsage } from '@agentistics/core'

const CONV = '20aa768c-36a0-456c-86d5-d97d4eb09194'

// Real-shaped history.jsonl (global, all conversations, slash commands included).
const HISTORY = [
  JSON.stringify({ display: '/model', timestamp: 1785172335771, workspace: '/home/padawan', type: 'slash_command' }),
  JSON.stringify({ display: '/config', timestamp: 1785172359466, workspace: '/home/padawan', conversationId: CONV, type: 'slash_command' }),
  JSON.stringify({ display: 'voce tem algo parecido com dynamic workflows?', timestamp: 1785172407299, workspace: '/home/padawan/agentistics', conversationId: CONV }),
].join('\n')

function userInput(step: number, at: string, request: string, extra = ''): string {
  return JSON.stringify({
    step_index: step,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: at,
    content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-27T14:13:27-03:00.\n</ADDITIONAL_METADATA>${extra}`,
  })
}

// ---------------------------------------------------------------------------
// history.jsonl
// ---------------------------------------------------------------------------

test('parses history.jsonl and flags slash commands', () => {
  const entries = parseAntigravityHistory(HISTORY)
  expect(entries).toHaveLength(3)
  expect(entries[0]!.conversationId).toBeUndefined()
  expect(entries[0]!.isSlashCommand).toBe(true)
  expect(entries[1]!.isSlashCommand).toBe(true)
  expect(entries[2]!.isSlashCommand).toBe(false)
})

test('workspace attribution comes from history.jsonl (last non-empty wins)', () => {
  const map = buildAntigravityWorkspaceMap(parseAntigravityHistory(HISTORY))
  expect(map.get(CONV)).toBe('/home/padawan/agentistics')
})

test('project_path is taken from the history workspace for that conversation', () => {
  const history = parseAntigravityHistory(HISTORY)
  const workspaces = buildAntigravityWorkspaceMap(history)
  const transcript = userInput(0, '2026-07-27T17:13:27Z', 'hello there')
  const s = parseAntigravityTranscript(transcript, CONV, workspaces.get(CONV) ?? '', { historyEntries: history })
  expect(s!.project_path).toBe('/home/padawan/agentistics')
})

// ---------------------------------------------------------------------------
// USER_REQUEST unwrapping
// ---------------------------------------------------------------------------

test('extractUserRequest strips the wrapper and metadata blocks', () => {
  const raw = '<USER_REQUEST>\nwhat is up\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>'
  expect(extractUserRequest(raw)).toBe('what is up')
  expect(extractUserRequest('<USER_SETTINGS_CHANGE>\nmodel\n</USER_SETTINGS_CHANGE>\nbare text')).toBe('bare text')
})

// ---------------------------------------------------------------------------
// A normal conversation
// ---------------------------------------------------------------------------

const NORMAL = [
  userInput(0, '2026-07-27T17:13:27Z', 'voce tem algo parecido com dynamic workflows?', '\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.6 Flash (Medium).\n</USER_SETTINGS_CHANGE>'),
  JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T17:13:27Z', thinking: 'hmm', tool_calls: [{ name: 'view_file', args: { path: 'a.ts' } }] }),
  JSON.stringify({ step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-07-27T17:13:29Z', content: 'file body' }),
  JSON.stringify({ step_index: 3, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-07-27T17:13:29Z', content: 'ck' }),
  JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T17:13:30Z', content: 'Yes, here is the answer.' }),
  JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T17:14:20Z', tool_calls: [{ name: 'search_web' }, { name: 'run_command' }] }),
  JSON.stringify({ step_index: 6, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T17:23:27Z', exit_code: 1, content: 'boom' }),
].join('\n')

test('parses a normal conversation', () => {
  const s = parseAntigravityTranscript(NORMAL, CONV, '/home/padawan')
  expect(s).not.toBeNull()
  expect(s!.session_id).toBe(CONV)
  expect(s!.harness).toBe('antigravity')
  expect(s!.first_prompt).toBe('voce tem algo parecido com dynamic workflows?')
  expect(s!.user_message_count).toBe(1)
  // Only PLANNER_RESPONSE steps carrying prose count as an assistant reply.
  expect(s!.assistant_message_count).toBe(1)
  expect(s!.tool_counts).toEqual({ Read: 1, search_web: 1, Bash: 1 })
  expect(s!.uses_web_search).toBe(true)
  expect(s!.uses_web_fetch).toBe(false)
  expect(s!.uses_mcp).toBe(false)
  expect(s!.tool_errors).toBe(1)
  expect(s!.start_time).toBe('2026-07-27T17:13:27.000Z')
  expect(s!.end_time).toBe('2026-07-27T17:23:27.000Z')
  expect(s!.duration_minutes).toBe(10)
  expect(s!.user_message_timestamps).toEqual(['2026-07-27T17:13:27Z'])
  expect(s!.message_hours).toEqual([17, 17])
})

test('tokens and model are zero/undefined when the conversation DB gives nothing', () => {
  const s = parseAntigravityTranscript(NORMAL, CONV, '/home/padawan')!
  expect(s.input_tokens).toBe(0)
  expect(s.output_tokens).toBe(0)
  expect(s.cache_read_input_tokens).toBe(0)
  expect(s.cache_creation_input_tokens).toBe(0)
  // The model is never inferred from the <USER_SETTINGS_CHANGE> prose — only from gen_metadata.
  expect(s.model).toBeUndefined()
})

test('tokens and model come from the decoded gen_metadata totals', () => {
  const s = parseAntigravityTranscript(NORMAL, CONV, '/home/padawan', {
    tokens: {
      inputTokens: 19296,
      cachedTokens: 126678,
      outputTokens: 17626,
      modelId: 'gemini-3.6-flash',
    },
  })!
  expect(s.input_tokens).toBe(19296)
  expect(s.cache_read_input_tokens).toBe(126678)
  expect(s.output_tokens).toBe(17626)
  // agy records no cache WRITES.
  expect(s.cache_creation_input_tokens).toBe(0)
  expect(s.model).toBe('gemini-3.6-flash')
})

// ---------------------------------------------------------------------------
// Slash-command-only / empty conversations are dropped
// ---------------------------------------------------------------------------

test('a conversation with only slash commands yields no session', () => {
  const transcript = [
    userInput(0, '2026-07-27T17:13:27Z', '/model'),
    userInput(1, '2026-07-27T17:13:30Z', '/usage'),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-07-27T17:13:31Z' }),
  ].join('\n')
  const slashOnlyHistory = parseAntigravityHistory([
    JSON.stringify({ display: '/model', timestamp: 1, workspace: '/w', conversationId: CONV, type: 'slash_command' }),
  ].join('\n'))
  expect(parseAntigravityTranscript(transcript, CONV, '/w', { historyEntries: slashOnlyHistory })).toBeNull()
})

test('an empty / bootstrap transcript yields no session', () => {
  expect(parseAntigravityTranscript('', CONV, '/w')).toBeNull()
  expect(parseAntigravityTranscript('\n\n', CONV, '/w')).toBeNull()
})

test('a path-like prompt is not mistaken for a slash command', () => {
  const t = userInput(0, '2026-07-27T17:13:27Z', '/home/padawan is where my code lives')
  const s = parseAntigravityTranscript(t, CONV, '/w')
  expect(s!.first_prompt).toBe('/home/padawan is where my code lives')
})

// ---------------------------------------------------------------------------
// Replayed history must not double count
// ---------------------------------------------------------------------------

test('CONVERSATION_HISTORY replays and repeated step_index are not double counted', () => {
  const first = userInput(0, '2026-07-27T17:13:27Z', 'first real prompt')
  const replay = JSON.stringify({
    step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE',
    created_at: '2026-07-27T17:13:27Z',
    content: '<USER_REQUEST>\nfirst real prompt\n</USER_REQUEST>',
    tool_calls: [{ name: 'view_file' }],
  })
  const answer = JSON.stringify({
    step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-07-27T17:13:28Z', content: 'ok', tool_calls: [{ name: 'view_file' }],
  })
  // The same step re-appended verbatim (resumed conversation appending its own log).
  const transcript = [first, replay, answer, first, answer].join('\n')

  const s = parseAntigravityTranscript(transcript, CONV, '/w')!
  expect(s.user_message_count).toBe(1)
  expect(s.assistant_message_count).toBe(1)
  expect(s.tool_counts).toEqual({ Read: 1 })
  expect(s.user_message_timestamps).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('truncated / malformed lines are skipped without throwing', () => {
  const transcript = [
    '{"step_index":0,"type":"USER_INPUT","created_at":"2026-07-27T17:13:27Z","content":"<USER_REQ',
    'not json at all',
    'null',
    '42',
    userInput(1, '2026-07-27T17:13:29Z', 'still a real prompt'),
    '{"step_index":2,"type":"PLANNER_RESPONSE","tool_calls":[{"noname":true},null],"created_at":"nope"}',
  ].join('\n')

  const s = parseAntigravityTranscript(transcript, CONV, '/w')
  expect(s).not.toBeNull()
  expect(s!.first_prompt).toBe('still a real prompt')
  expect(s!.user_message_count).toBe(1)
  expect(s!.tool_counts).toEqual({})
  // The unparseable created_at contributes no timestamp.
  expect(s!.start_time).toBe('2026-07-27T17:13:29.000Z')
})

test('malformed history lines are skipped', () => {
  const entries = parseAntigravityHistory('{"display":"a","timestamp":1,"workspace":"/w"}\ngarbage\n{"broken":')
  expect(entries).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// first_prompt fallback via history.jsonl
// ---------------------------------------------------------------------------

test('first_prompt falls back to history when the transcript carries no USER_INPUT', () => {
  const history = parseAntigravityHistory(HISTORY)
  const transcript = JSON.stringify({
    step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-07-27T17:13:27Z', content: 'answering',
  })
  const s = parseAntigravityTranscript(transcript, CONV, '/w', { historyEntries: history })
  expect(s).not.toBeNull()
  expect(s!.first_prompt).toBe('voce tem algo parecido com dynamic workflows?')
})

// ---------------------------------------------------------------------------
// invoke_subagent child conversations
// ---------------------------------------------------------------------------

// Real shape: the parent's own transcript names each child it spawned.
const PARENT_WITH_SUBAGENTS = [
  userInput(0, '2026-07-27T18:05:00Z', 'research the repo with three subagents'),
  JSON.stringify({
    step_index: 11, source: 'MODEL', type: 'INVOKE_SUBAGENT', status: 'DONE',
    created_at: '2026-07-27T18:06:00Z',
    content: 'Created the following subagents:\n'
      + '{\n  "conversationId":  "8922cd26-9cef-45be-81bc-9148cc305586",\n'
      + '  "logAbsoluteUri":  "file:///home/padawan/.gemini/antigravity-cli/brain/8922cd26/x.jsonl"\n}\n'
      + '{\n  "conversationId":  "b748de2f-081d-49a8-af04-010871426529"\n}\n',
    tool_calls: [{ name: 'invoke_subagent', args: { Subagents: [{ Role: 'research' }] } }],
  }),
].join('\n')

test('collectSubagentChildIds reads the child ids out of the parent transcript', () => {
  expect(collectSubagentChildIds(PARENT_WITH_SUBAGENTS)).toEqual([
    '8922cd26-9cef-45be-81bc-9148cc305586',
    'b748de2f-081d-49a8-af04-010871426529',
  ])
  expect(collectSubagentChildIds(NORMAL)).toEqual([])
  expect(collectSubagentChildIds('garbage\n{"broken":')).toEqual([])
})

test('buildAntigravityChildSet unions transcript INVOKE_SUBAGENT links and summary rows', () => {
  const set = buildAntigravityChildSet(
    [['parent-1', PARENT_WITH_SUBAGENTS], ['other', NORMAL]],
    [
      { conversation_id: 'from-summary', parent_conversation_id: 'parent-1' },
      { conversation_id: 'nested', nesting_depth: 2 },
      { conversation_id: 'top-level', parent_conversation_id: '', nesting_depth: 0 },
    ],
  )
  expect(set.has('8922cd26-9cef-45be-81bc-9148cc305586')).toBe(true)
  expect(set.has('b748de2f-081d-49a8-af04-010871426529')).toBe(true)
  expect(set.has('from-summary')).toBe(true)
  expect(set.has('nested')).toBe(true)
  expect(set.has('top-level')).toBe(false)
  expect(set.has('parent-1')).toBe(false)
})

test('a proven invoke_subagent child is dropped; everything else is kept', () => {
  const childId = '8922cd26-9cef-45be-81bc-9148cc305586'
  const childIds = buildAntigravityChildSet([['parent-1', PARENT_WITH_SUBAGENTS]])
  const child = userInput(0, '2026-07-27T18:06:00Z', 'Read the architecture docs and summarize.')
  expect(parseAntigravityTranscript(child, childId, '', { childIds })).toBeNull()
  expect(parseAntigravityTranscript(child, 'unrelated-id', '', { childIds })).not.toBeNull()
})

test('P2: a conversation missing from history.jsonl is NEVER dropped for that reason alone', () => {
  // history.jsonl rotates / gets cleared. A real transcript must survive that.
  const history = parseAntigravityHistory(HISTORY) // only names CONV
  const orphan = userInput(0, '2026-07-27T18:06:00Z', 'a real prompt nobody remembers')
  const s = parseAntigravityTranscript(orphan, 'rotated-away-id', '', { historyEntries: history })
  expect(s).not.toBeNull()
  expect(s!.first_prompt).toBe('a real prompt nobody remembers')
})

test('with no history available every conversation is kept', () => {
  const t = userInput(0, '2026-07-27T18:06:00Z', 'a real prompt')
  expect(parseAntigravityTranscript(t, 'unknown-id', '')).not.toBeNull()
})

// ---------------------------------------------------------------------------
// P4 — tool errors
// ---------------------------------------------------------------------------

test('P4: ERROR_MESSAGE steps are counted and no step is counted twice', () => {
  const transcript = [
    userInput(0, '2026-07-27T18:00:00Z', 'do the thing'),
    // Real shape: status is DONE even though the step IS the error.
    JSON.stringify({
      step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE',
      created_at: '2026-07-27T18:00:01Z', error_code: 429,
      error: 'The model API is currently overloaded.',
      content: 'Error: The model API is currently overloaded.',
    }),
    JSON.stringify({
      step_index: 2, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE',
      created_at: '2026-07-27T18:00:02Z', content: 'Error: model output error',
    }),
    // Would previously increment twice (non-zero exit_code AND status ERROR).
    JSON.stringify({
      step_index: 3, source: 'MODEL', type: 'RUN_COMMAND', status: 'ERROR',
      created_at: '2026-07-27T18:00:03Z', exit_code: 2, content: 'boom',
    }),
    // A plain failed step with no exit code.
    JSON.stringify({
      step_index: 4, source: 'MODEL', type: 'VIEW_FILE', status: 'FAILED',
      created_at: '2026-07-27T18:00:04Z',
    }),
    // An ERROR_MESSAGE that also carries a bogus exit_code must still count once.
    JSON.stringify({
      step_index: 5, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'ERROR',
      created_at: '2026-07-27T18:00:05Z', exit_code: 7, error_code: 500,
    }),
  ].join('\n')
  const s = parseAntigravityTranscript(transcript, CONV, '/w')!
  expect(s.tool_errors).toBe(5)
  expect(s.tool_error_categories).toEqual({
    error_429: 1,
    error_message: 1,
    exit_code: 1,
    status_error: 1,
    error_500: 1,
  })
})

test('a successful run_command (exit_code 0) is not an error', () => {
  const transcript = [
    userInput(0, '2026-07-27T18:00:00Z', 'run it'),
    JSON.stringify({ step_index: 1, type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T18:00:01Z', exit_code: 0 }),
  ].join('\n')
  const s = parseAntigravityTranscript(transcript, CONV, '/w')!
  expect(s.tool_errors).toBe(0)
  expect(s.tool_error_categories).toEqual({})
})

// ---------------------------------------------------------------------------
// P5 — files modified and line deltas
// ---------------------------------------------------------------------------

test('P5: files_modified counts DISTINCT TargetFile paths, and line deltas are counted', () => {
  const transcript = [
    userInput(0, '2026-07-27T18:00:00Z', 'edit some files'),
    JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:00:01Z',
      tool_calls: [{
        name: 'write_to_file',
        args: { TargetFile: '/repo/a.md', CodeContent: 'one\ntwo\nthree\n' },
      }],
    }),
    // Same file edited again — must not count twice.
    JSON.stringify({
      step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:00:02Z',
      tool_calls: [{
        name: 'replace_file_content',
        args: { TargetFile: '/repo/a.md', TargetContent: 'one\ntwo', ReplacementContent: 'ONE' },
      }],
    }),
    JSON.stringify({
      step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:00:03Z',
      tool_calls: [{
        name: 'multi_replace_file_content',
        args: {
          TargetFile: '/repo/b.ts',
          ReplacementChunks: [
            { TargetContent: 'a\nb\nc', ReplacementContent: 'x' },
            { TargetContent: 'd', ReplacementContent: 'y\nz' },
          ],
        },
      }],
    }),
    // Reads must never be counted as modifications.
    JSON.stringify({
      step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:00:04Z',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/repo/c.ts' } }],
    }),
  ].join('\n')
  const s = parseAntigravityTranscript(transcript, CONV, '/w')!
  expect(s.files_modified).toBe(2)
  // 3 (CodeContent) + 1 (ONE) + 1 (x) + 2 (y\nz)
  expect(s.lines_added).toBe(7)
  // 2 (one\ntwo) + 3 (a\nb\nc) + 1 (d)
  expect(s.lines_removed).toBe(6)
})

test('P5: a CODE_ACTION step contributes the file it names, deduped against the tool call', () => {
  const written = '/home/padawan/brain/analise.md'
  const transcript = [
    userInput(0, '2026-07-27T18:00:00Z', 'write the report'),
    JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:00:01Z',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: written, CodeContent: 'x' } }],
    }),
    JSON.stringify({
      step_index: 2, source: 'MODEL', type: 'CODE_ACTION', status: 'DONE',
      created_at: '2026-07-27T18:00:02Z',
      content: `Created file file://${written} with requested content.`,
    }),
  ].join('\n')
  const s = parseAntigravityTranscript(transcript, CONV, '/w')!
  expect(s.files_modified).toBe(1)
})

test('fileUriToPath decodes file:// URIs and rejects anything else', () => {
  expect(fileUriToPath('file:///home/padawan/a%20b.md')).toBe('/home/padawan/a b.md')
  expect(fileUriToPath('/home/padawan')).toBe('')
  expect(fileUriToPath('https://example.com/x')).toBe('')
})

// ---------------------------------------------------------------------------
// conversation_summaries.db enrichment (optional — the table is often empty)
// ---------------------------------------------------------------------------

test('a summary row supplies the title and a project_path fallback', () => {
  const t = userInput(0, '2026-07-27T18:00:00Z', 'hello')
  const s = parseAntigravityTranscript(t, CONV, '', {
    summary: {
      conversation_id: CONV,
      preview: 'Comparação De Fluxos Dinâmicos',
      workspace_uris: '["file:///home/padawan"]',
    },
  })!
  expect(s.project_path).toBe('/home/padawan')
  expect(s.title).toBe('Comparação De Fluxos Dinâmicos')
})

test('a malformed summary row never breaks the parse', () => {
  const t = userInput(0, '2026-07-27T18:00:00Z', 'hello')
  const s = parseAntigravityTranscript(t, CONV, '', {
    summary: { conversation_id: CONV, workspace_uris: '{not json' },
  })!
  expect(s.project_path).toBe('')
  expect(s.title).toBeUndefined()
})

// ---------------------------------------------------------------------------
// D1 — sub-agent rollup: every gen_metadata row counted EXACTLY once
// ---------------------------------------------------------------------------

const CHILD_A = '8922cd26-9cef-45be-81bc-9148cc305586'
const CHILD_B = 'b748de2f-081d-49a8-af04-010871426529'

function tokens(input: number, cached: number, output: number, model: string): AntigravityTokenTotals {
  return {
    inputTokens: input, cachedTokens: cached, outputTokens: output, modelId: model,
    byModel: { [model]: { inputTokens: input, cachedTokens: cached, outputTokens: output } },
  }
}

/** Build the {id → parsed} map the adapter feeds the rollup (children allowNoUserTurn). */
function parseAll(
  entries: [string, string, AntigravityTokenTotals][],
  parentOf: Map<string, string>,
) {
  const map = new Map<string, ReturnType<typeof parseAntigravityTranscriptDetailed>>()
  for (const [id, transcript, tok] of entries) {
    const parsed = parseAntigravityTranscriptDetailed(transcript, id, '', {
      tokens: tok,
      allowNoUserTurn: parentOf.has(id),
    })
    if (parsed) map.set(id, parsed)
  }
  return map as Map<string, NonNullable<ReturnType<typeof parseAntigravityTranscriptDetailed>>>
}

test('buildAntigravityParentMap links each child to the parent that spawned it', () => {
  const parentOf = buildAntigravityParentMap(
    [['parent-1', PARENT_WITH_SUBAGENTS], ['other', NORMAL]],
    [{ conversation_id: 'from-summary', parent_conversation_id: 'sum-parent' }],
  )
  expect(parentOf.get(CHILD_A)).toBe('parent-1')
  expect(parentOf.get(CHILD_B)).toBe('parent-1')
  expect(parentOf.get('from-summary')).toBe('sum-parent')
  expect(parentOf.has('parent-1')).toBe(false)
})

test('D1 INVARIANT: every gen_metadata row is counted exactly once after the rollup', () => {
  const parentOf = buildAntigravityParentMap([['parent-1', PARENT_WITH_SUBAGENTS]])
  // Real-shaped numbers: an Opus parent whose two Gemini Flash children hold most of the spend.
  const parsed = parseAll([
    ['parent-1', PARENT_WITH_SUBAGENTS, tokens(6156, 62593, 15731, 'claude-opus-4-6-thinking')],
    [CHILD_A, userInput(0, '2026-07-27T18:07:00Z', 'read the docs'), tokens(3588, 27973, 5371, 'gemini-3.6-flash-tiered')],
    [CHILD_B, userInput(0, '2026-07-27T18:08:00Z', 'map the code'), tokens(25116, 104596, 8732, 'gemini-3.6-flash-tiered')],
  ], parentOf)

  const sessions = rollUpAntigravitySessions(parsed, parentOf)

  // The children are gone as sessions...
  expect(sessions.map(s => s.session_id)).toEqual(['parent-1'])
  // ...and their tokens are all inside the parent — nothing lost, nothing doubled.
  const parent = sessions[0]!
  expect(parent.input_tokens).toBe(6156 + 3588 + 25116)
  expect(parent.cache_read_input_tokens).toBe(62593 + 27973 + 104596)
  expect(parent.output_tokens).toBe(15731 + 5371 + 8732)

  // Cost stays per-model: the Gemini children are NOT priced at the Opus rate.
  const perModel = sessionModelUsage(parent)
  expect(Object.fromEntries(perModel.map(([m, u]) => [m, u.inputTokens]))).toEqual({
    'claude-opus-4-6-thinking': 6156,
    'gemini-3.6-flash-tiered': 3588 + 25116,
  })
  const rolledCost = perModel.reduce((sum, [m, u]) => sum + calcCost(u, m), 0)
  const separateCost =
    calcCost({ inputTokens: 6156, outputTokens: 15731, cacheReadInputTokens: 62593, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }, 'claude-opus-4-6-thinking')
    + calcCost({ inputTokens: 3588, outputTokens: 5371, cacheReadInputTokens: 27973, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }, 'gemini-3.6-flash-tiered')
    + calcCost({ inputTokens: 25116, outputTokens: 8732, cacheReadInputTokens: 104596, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }, 'gemini-3.6-flash-tiered')
  expect(rolledCost).toBeCloseTo(separateCost, 10)

  // The single model label stays the PARENT's own dominant model.
  expect(parent.model).toBe('claude-opus-4-6-thinking')
})

test('rollup folds a grandchild into the root, not just one level', () => {
  const parentOf = new Map([[CHILD_A, 'parent-1'], [CHILD_B, CHILD_A]])
  const parsed = parseAll([
    ['parent-1', userInput(0, '2026-07-27T18:06:00Z', 'root prompt'), tokens(10, 0, 1, 'gemini-3.6-flash')],
    [CHILD_A, userInput(0, '2026-07-27T18:07:00Z', 'child'), tokens(20, 0, 2, 'gemini-3.6-flash')],
    [CHILD_B, userInput(0, '2026-07-27T18:08:00Z', 'grandchild'), tokens(40, 0, 4, 'gemini-3.6-flash')],
  ], parentOf)
  const sessions = rollUpAntigravitySessions(parsed, parentOf)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.input_tokens).toBe(70)
  expect(sessions[0]!.output_tokens).toBe(7)
})

test('an orphan child (parent chain missing) survives as its own session — spend is never dropped', () => {
  const parentOf = new Map([[CHILD_A, 'a-parent-that-was-deleted']])
  const parsed = parseAll([
    [CHILD_A, userInput(0, '2026-07-27T18:07:00Z', 'orphaned work'), tokens(20, 5, 2, 'gemini-3.6-flash')],
  ], parentOf)
  const sessions = rollUpAntigravitySessions(parsed, parentOf)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.input_tokens).toBe(20)
})

test('mergeAntigravityChild: work is folded, invented user activity is not', () => {
  const parentOf = new Map([[CHILD_A, 'parent-1']])
  const parentTranscript = [
    PARENT_WITH_SUBAGENTS,
    JSON.stringify({
      step_index: 90, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:09:00Z',
      tool_calls: [{ name: 'view_file', args: {} }, {
        name: 'write_to_file',
        args: { TargetFile: '/repo/shared.ts', CodeContent: 'a\nb\n' },
      }],
    }),
  ].join('\n')
  const childTranscript = [
    userInput(0, '2026-07-27T18:07:00Z', 'do the research'),
    JSON.stringify({
      step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T18:20:00Z',
      tool_calls: [{ name: 'view_file', args: {} }, {
        name: 'write_to_file',
        // Same file as the parent (must be unioned) + one of its own.
        args: { TargetFile: '/repo/shared.ts', CodeContent: 'x\n' },
      }, {
        name: 'write_to_file',
        args: { TargetFile: '/repo/child-only.ts', CodeContent: 'y\nz\n' },
      }],
    }),
    JSON.stringify({ step_index: 6, type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-07-27T18:21:00Z', error_code: 7 }),
  ].join('\n')

  const parsed = parseAll([
    ['parent-1', parentTranscript, tokens(100, 10, 10, 'claude-opus-4-6-thinking')],
    [CHILD_A, childTranscript, tokens(50, 5, 5, 'gemini-3.6-flash-tiered')],
  ], parentOf)
  const before = parsed.get('parent-1')!.session
  const merged = rollUpAntigravitySessions(parsed, parentOf)[0]!

  // Work IS folded.
  expect(merged.tool_counts.Read).toBe(2)
  expect(merged.tool_counts.Write).toBe(3)
  expect(merged.tool_errors).toBe(1)
  expect(merged.tool_error_categories.error_7).toBe(1)
  expect(merged.lines_added).toBe(2 + 1 + 2)
  // Files are UNIONED, not summed: shared.ts + child-only.ts = 2, never 3.
  expect(merged.files_modified).toBe(2)
  // The dispatch signal survives.
  expect(merged.uses_task_agent).toBe(true)
  // User-facing counts are NOT inflated by the child's dispatch prompt.
  expect(merged.user_message_count).toBe(before.user_message_count)
  expect(merged.message_hours).toEqual(before.message_hours)
  expect(merged.user_message_timestamps).toEqual(before.user_message_timestamps)
  // The window is extended to cover the child's work.
  expect(merged.end_time).toBe('2026-07-27T18:21:00.000Z')
})

// Regression: a pure orchestrator (dispatches subagents, generates no gen_metadata rows of its
// own) must not end up with model === undefined after the merge, or every consumer that keys off
// `model` first (useData.ts's per-model aggregation, sessionModelUsage's own fallback) silently
// drops the session's real, merged-in child tokens/cost from every total — while a raw
// `input_tokens` sum stays correct, so the discrepancy is invisible until totals are compared
// against a source of truth (measured: 232M tokens on the vendor's own quota panel vs 407K on a
// harness-filtered agentistics total, for a fleet with several long orchestrator sessions).
test('mergeAntigravityChild: a parentless model falls back to the dominant merged model', () => {
  const parentOf = new Map([[CHILD_A, 'parent-1']])
  const parentTranscript = PARENT_WITH_SUBAGENTS
  const childTranscript = userInput(0, '2026-07-27T18:07:00Z', 'do the research')

  // The parent's own DB has zero gen_metadata rows (empty model) — everything real happened in
  // the one child, under one model.
  const parsed = parseAll([
    ['parent-1', parentTranscript, tokens(0, 0, 0, '')],
    [CHILD_A, childTranscript, tokens(50, 5, 5, 'gemini-3.6-flash-tiered')],
  ], parentOf)
  const merged = rollUpAntigravitySessions(parsed, parentOf)[0]!

  // `model` must carry the dominant model, not be dropped as undefined — with only one model
  // involved, model_usage is not populated (by design), so `model` is the ONLY place this
  // session's model — and therefore its tokens, via every model-keyed consumer — can be found.
  expect(merged.model).toBe('gemini-3.6-flash-tiered')
  expect(merged.model_usage).toBeUndefined()
  expect(merged.input_tokens).toBe(50)
  expect(merged.cache_read_input_tokens).toBe(5)
  expect(merged.output_tokens).toBe(5)
})

test('D5: uses_task_agent is true exactly when the conversation dispatched a sub-agent', () => {
  const parent = parseAntigravityTranscript(PARENT_WITH_SUBAGENTS, 'parent-1', '')
  expect(parent!.uses_task_agent).toBe(true)
  const plain = parseAntigravityTranscript(NORMAL, 'plain-1', '')
  expect(plain!.uses_task_agent).toBe(false)
})

// --- activity hours are LOCAL, like the Claude pipeline ------------------------------------------
// agy writes `created_at` in UTC. Reading it back with getUTCHours() put the peak-usage chart in the
// wrong bucket for every user outside UTC (a 17:13Z step showed as 5 PM while the wall clock said
// 14:13), and mixed two clocks in the unified view since jsonl.ts uses local hours for Claude.
test('message_hours uses the local clock, not UTC', () => {
  // The test runner's own TZ is UTC, where local and UTC hours coincide and the bug is invisible.
  // Pin an offset zone so the two clocks disagree and the assertion can actually fail.
  const originalTz = process.env.TZ
  process.env.TZ = 'America/Sao_Paulo'
  try {
    const iso = '2026-07-27T17:13:27Z' // 14:13 in São Paulo
    const transcript = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
        created_at: iso, content: '<USER_REQUEST>oi</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
        created_at: iso, content: 'ola' }),
    ].join('\n')

    const s = parseAntigravityTranscript(transcript, 'conv-tz', '/proj')
    expect(s).not.toBeNull()
    expect(s!.message_hours.length).toBeGreaterThan(0) // an empty array would pass every() vacuously
    expect(new Date(iso).getTimezoneOffset()).not.toBe(0) // the fixture is only meaningful off UTC
    expect(s!.message_hours.every(h => h === 14)).toBe(true)
    expect(s!.message_hours).not.toContain(17) // 17 is what getUTCHours() produced
  } finally {
    // Restore explicitly rather than deleting: V8 caches the zone, so `delete` leaves São Paulo in
    // place and every later test file in this process buckets its hours wrong. The runner's default
    // is UTC (bun test ignores the shell TZ), so that is what "no TZ set" means here.
    process.env.TZ = originalTz ?? 'UTC'
  }
})

test('counts agy git commands from RUN_COMMAND steps, under the shared tool name', () => {
  const lines = [
    JSON.stringify({ step_index: 0, source: 'USER', type: 'USER_INPUT', status: 'DONE', created_at: '2026-07-27T17:23:20Z', content: 'go' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T17:23:25Z', exit_code: 0, content: 'git add -A && git commit -m "x"' }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T17:23:26Z', exit_code: 0, content: 'git push origin main' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T17:23:27Z', exit_code: 0, content: 'bun test' }),
  ]
  const s = parseAntigravityTranscript(lines.join('\n'), 'c1', '/repo')!
  expect(s.git_commits).toBe(1)
  expect(s.git_pushes).toBe(1)
  expect(s.tool_counts['Bash']).toBe(3)
})

test('a failed agy command still counted as a command, and still an error', () => {
  const lines = [
    JSON.stringify({ step_index: 0, source: 'USER', type: 'USER_INPUT', status: 'DONE', created_at: '2026-07-27T17:23:20Z', content: 'go' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T17:23:25Z', exit_code: 1, content: 'git commit -m x' }),
  ]
  const s = parseAntigravityTranscript(lines.join('\n'), 'c2', '/repo')!
  expect(s.git_commits).toBe(1)
  expect(s.tool_errors).toBe(1)
})

test('a requested command and its execution are ONE command, never two', () => {
  const lines = [
    JSON.stringify({ step_index: 0, source: 'USER', type: 'USER_INPUT', status: 'DONE', created_at: '2026-07-27T17:23:20Z', content: 'go' }),
    // The model asks…
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-27T17:23:24Z', tool_calls: [{ name: 'run_command' }] }),
    // …and it runs. Same command.
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-07-27T17:23:25Z', exit_code: 0, content: 'git commit -m x' }),
  ].join('\n')
  const s = parseAntigravityTranscript(lines, 'c3', '/repo')!
  expect(s.tool_counts['Bash']).toBe(1)
  expect(s.git_commits).toBe(1)
})

// ---------------------------------------------------------------------------
// AGY.REOPEN — a conversation agentop STARTED. agy writes history.jsonl only for a prompt typed in
// its own UI, so these arrive with no workspace there; the project path must come from what
// agentop itself controls: its session registry, then the context block it prepended.
// ---------------------------------------------------------------------------

const AGENTOP_CONV = 'c2cc0410-62b8-46fe-890f-48bc9886df8f'
const CTX = contextBlock({ sessionId: '90b6e4d348', cwd: '/home/u/my.project/work' })

test('projectFolderFromContext reads the folder agentop wrote, dots in the path included', () => {
  expect(projectFolderFromContext(CTX)).toBe('/home/u/my.project/work')
  expect(projectFolderFromContext('no context here')).toBe('')
})

test('an agentop-started conversation takes its project path from the registry', () => {
  const transcript = userInput(0, '2026-10-09T04:37:55Z', `${CTX}\n\nsay hi`)
  const s = parseAntigravityTranscript(transcript, AGENTOP_CONV, '', { managedCwd: '/registry/cwd' })
  expect(s!.project_path).toBe('/registry/cwd')
})

test('with no registry row, the context block names the project folder', () => {
  const transcript = userInput(0, '2026-10-09T04:37:55Z', `${CTX}\n\nsay hi`)
  const s = parseAntigravityTranscript(transcript, AGENTOP_CONV, '')
  expect(s!.project_path).toBe('/home/u/my.project/work')
})

test('history.jsonl (the harness\'s own statement) still outranks the registry and the context', () => {
  const transcript = userInput(0, '2026-10-09T04:37:55Z', `${CTX}\n\nsay hi`)
  const s = parseAntigravityTranscript(transcript, AGENTOP_CONV, '/from/history', { managedCwd: '/registry/cwd' })
  expect(s!.project_path).toBe('/from/history')
})

test('the context block never becomes the first_prompt — the person\'s words do', () => {
  const transcript = userInput(0, '2026-10-09T04:37:55Z', `${CTX}\n\nsay hi`)
  const s = parseAntigravityTranscript(transcript, AGENTOP_CONV, '')
  expect(s!.first_prompt).toBe('say hi')
})

test('context sent ALONE: still a real conversation, first_prompt from the next message', () => {
  const transcript = [
    userInput(0, '2026-10-09T04:37:55Z', CTX),
    userInput(1, '2026-10-09T04:38:10Z', 'now the real question'),
  ].join('\n')
  const s = parseAntigravityTranscript(transcript, AGENTOP_CONV, '')
  expect(s).not.toBeNull()
  expect(s!.first_prompt).toBe('now the real question')
  expect(s!.project_path).toBe('/home/u/my.project/work')
})

test('context alone and nothing else: kept (its tokens are real), first_prompt empty', () => {
  const s = parseAntigravityTranscript(userInput(0, '2026-10-09T04:37:55Z', CTX), AGENTOP_CONV, '')
  expect(s).not.toBeNull()
  expect(s!.first_prompt).toBe('')
})

test('a history line that is only agentop\'s context is not taken as the first prompt', () => {
  const history = parseAntigravityHistory(JSON.stringify({
    display: CTX, timestamp: 1, workspace: '/w', conversationId: AGENTOP_CONV,
  }))
  const s = parseAntigravityTranscript(userInput(0, '2026-10-09T04:37:55Z', CTX), AGENTOP_CONV, '', { historyEntries: history })
  expect(s!.first_prompt).toBe('')
})

test('managedAntigravityCwds: agy rows with an exact id and a cwd, newest row wins', () => {
  const raw = JSON.stringify([
    { id: 'a', harness: 'antigravity', cwd: '/old', conversationId: 'X', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'b', harness: 'antigravity', cwd: '/new', conversationId: 'X', createdAt: '2026-10-02T00:00:00Z' },
    { id: 'c', harness: 'antigravity', cwd: '/older', conversationId: 'X', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'd', harness: 'claude', cwd: '/claude', conversationId: 'Y' },
    { id: 'e', harness: 'antigravity', cwd: '/no-id' },
    { id: 'f', harness: 'antigravity', conversationId: 'Z' },
  ])
  const m = managedAntigravityCwds(raw)
  expect([...m]).toEqual([['X', '/new']])
})

test('managedAntigravityCwds is total: missing, broken or non-array input is an empty map', () => {
  expect(managedAntigravityCwds('').size).toBe(0)
  expect(managedAntigravityCwds('{not json').size).toBe(0)
  expect(managedAntigravityCwds('{"a":1}').size).toBe(0)
})
