/**
 * Fixture table for `deriveEventId` (./event-id.ts).
 *
 * WHY THIS TABLE EXISTS
 * ----------------------
 * `deriveEventId` gives every canonical event a deterministic id, and the shapes it has to
 * handle are not invented — they are the actual quirks of Claude Code's own JSONL format,
 * measured on real transcripts under `~/.claude/projects/**\/*.jsonl` (and, for a subagent,
 * `~/.claude/projects/<project>/<session-id>/subagents/agent-*.jsonl`). Two defects this repo
 * has already hit once (see `packages/server/server/usage-dedupe.ts` and
 * `agent-metrics.ts`/`subagent-join.ts` in this same worktree) both came from the SAME root
 * cause: a transcript states one fact in several places (one assistant turn split across
 * several JSONL lines that share a `message.id`, a subagent transcript that duplicates a
 * parent's launch), and a naive line-by-line id would either collide or fail to. A fixture
 * built from invented data cannot catch that — only a real transcript's actual line shapes can.
 *
 * PRIVACY (hard rule, master spec §42)
 * -------------------------------------
 * Every record below keeps ONLY ids, types, counters, timestamps, and tool NAMES. There is no
 * message content or text, no `thinking` body, no tool inputs/outputs, no file paths, no home
 * paths, no `cwd`, no `gitBranch`, no usernames, no credentials, and no customer text anywhere
 * in this file — a fixture that could not be published is a defect. The conversation/session
 * UUIDs, `uuid`, `message.id` (`msg_…`) and `tool_use` ids (`toolu_…`) ARE allowed: they are
 * random identifiers, not content, and `deriveEventId` needs real ones to be tested honestly.
 *
 * PROVENANCE
 * ----------
 * Extracted 2026-09-25 from real transcripts on this machine. Every field below is copied
 * VERBATIM from the source line — ids, timestamps, model names, tool names, token counts — with
 * ONLY the fields reduced (irrelevant/sensitive keys dropped, content arrays collapsed to their
 * block `type`s). Nothing here is synthesized. The `conversationId` on each fixture is the
 * source file's own session id (never a path).
 */

/** One transcript line, reduced to structural fields. */
export interface ClaudeLineShape {
  /** 1-based line number in the source file. */
  lineNo: number
  type: string // 'user' | 'assistant' | 'system' | ... as in the file
  subtype?: string // system lines, e.g. 'compact_boundary'
  uuid?: string
  timestamp: string
  sessionId: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: {
    id?: string // Anthropic's response id (msg_…), assistant lines only
    model?: string
    role?: string
    /** The `type` of each content block, in order, e.g. ['text'] / ['tool_use','tool_use'] / ['tool_result']. */
    contentTypes: string[]
    /** `id` of each tool_use block on this line, in order (omit when none). */
    toolUseIds?: string[]
    /** `name` of each tool_use block on this line, in order (omit when none). */
    toolNames?: string[]
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
  }
}

export interface EventIdFixture {
  /** kebab-case, one of the required names below */
  name: string
  /** one sentence: what property of the id this record shape exercises */
  why: string
  /** the conversation the lines come from (the file's session id) */
  conversationId: string
  /** 'transcript' for a main transcript, 'subagent' for subagents/agent-*.jsonl */
  file: 'transcript' | 'subagent'
  lines: ClaudeLineShape[]
}

export const CLAUDE_EVENT_ID_FIXTURES: readonly EventIdFixture[] = [
  {
    name: 'split-assistant-turn',
    why: 'One assistant turn (a text block, then a tool_use) is written as two JSONL lines sharing ONE message.id with byte-identical usage — the usage-dedupe.ts case; an id keyed on the line rather than on message.id would mint two ids and double-count the turn.',
    conversationId: 'f27fb298-0ab3-4941-a1f8-c56a39f4544c',
    file: 'transcript',
    lines: [
      {
        lineNo: 18,
        type: 'assistant',
        uuid: 'ff5a27fa-e89d-4524-912b-d09f9bda429f',
        timestamp: '2026-09-06T17:42:20.681Z',
        sessionId: 'f27fb298-0ab3-4941-a1f8-c56a39f4544c',
        isSidechain: false,
        message: {
          id: 'msg_011CenbfqkFbnVdagfuKgudC',
          model: 'claude-opus-5',
          role: 'assistant',
          contentTypes: ['text'],
          usage: {
            input_tokens: 2,
            output_tokens: 130,
            cache_read_input_tokens: 26355,
            cache_creation_input_tokens: 88874,
          },
        },
      },
      {
        lineNo: 19,
        type: 'assistant',
        uuid: 'a090e662-fff7-4782-9a62-b3bb9dd2328d',
        timestamp: '2026-09-06T17:42:21.213Z',
        sessionId: 'f27fb298-0ab3-4941-a1f8-c56a39f4544c',
        isSidechain: false,
        message: {
          id: 'msg_011CenbfqkFbnVdagfuKgudC',
          model: 'claude-opus-5',
          role: 'assistant',
          contentTypes: ['tool_use'],
          toolUseIds: ['toolu_01X1g6TCPxwuVmwoN1FtC7sG'],
          toolNames: ['Bash'],
          usage: {
            input_tokens: 2,
            output_tokens: 130,
            cache_read_input_tokens: 26355,
            cache_creation_input_tokens: 88874,
          },
        },
      },
    ],
  },
  {
    name: 'parallel-tool-uses',
    why: 'One assistant response (one message.id) launches two DIFFERENT tools, each its own tool_use block on its own line — the id must be able to tell those two tool_use events apart even though they share a response id and a timestamp neighbourhood.',
    conversationId: 'f803d279-c0cb-4ce9-8847-c1d130ef76eb',
    file: 'transcript',
    lines: [
      {
        lineNo: 43,
        type: 'assistant',
        uuid: '5f8222bc-e273-4cfa-b78d-9158959091cd',
        timestamp: '2026-09-11T20:59:17.721Z',
        sessionId: 'f803d279-c0cb-4ce9-8847-c1d130ef76eb',
        isSidechain: false,
        message: {
          id: 'msg_011CexKjUZpXzbKZTCdBpif6',
          model: 'claude-opus-5',
          role: 'assistant',
          contentTypes: ['tool_use'],
          toolUseIds: ['toolu_01RiwvD2ynHRLBGmcvwaLRXK'],
          toolNames: ['mcp__agentistics__agentistics_task'],
          usage: {
            input_tokens: 2,
            output_tokens: 200,
            cache_read_input_tokens: 149671,
            cache_creation_input_tokens: 3932,
          },
        },
      },
      {
        lineNo: 44,
        type: 'assistant',
        uuid: '0faecece-9663-4a3d-81a2-de7c81f16460',
        timestamp: '2026-09-11T20:59:18.869Z',
        sessionId: 'f803d279-c0cb-4ce9-8847-c1d130ef76eb',
        isSidechain: false,
        message: {
          id: 'msg_011CexKjUZpXzbKZTCdBpif6',
          model: 'claude-opus-5',
          role: 'assistant',
          contentTypes: ['tool_use'],
          toolUseIds: ['toolu_01C6Kmk8YwyHb18rBdPPgMor'],
          toolNames: ['Bash'],
          usage: {
            input_tokens: 2,
            output_tokens: 200,
            cache_read_input_tokens: 149671,
            cache_creation_input_tokens: 3932,
          },
        },
      },
    ],
  },
  {
    name: 'distinct-responses',
    why: 'Two assistant lines in the same conversation carry DIFFERENT message.ids (two separate API responses) — the id must not collapse them into one event just because they sit in the same conversation and are close in time.',
    conversationId: 'f27fb298-0ab3-4941-a1f8-c56a39f4544c',
    file: 'transcript',
    lines: [
      {
        lineNo: 18,
        type: 'assistant',
        uuid: 'ff5a27fa-e89d-4524-912b-d09f9bda429f',
        timestamp: '2026-09-06T17:42:20.681Z',
        sessionId: 'f27fb298-0ab3-4941-a1f8-c56a39f4544c',
        isSidechain: false,
        message: {
          id: 'msg_011CenbfqkFbnVdagfuKgudC',
          model: 'claude-opus-5',
          role: 'assistant',
          contentTypes: ['text'],
          usage: {
            input_tokens: 2,
            output_tokens: 130,
            cache_read_input_tokens: 26355,
            cache_creation_input_tokens: 88874,
          },
        },
      },
      {
        lineNo: 32,
        type: 'assistant',
        uuid: '37579b71-7d8f-4856-b78a-ac5260021e9c',
        timestamp: '2026-09-06T17:42:32.240Z',
        sessionId: 'f27fb298-0ab3-4941-a1f8-c56a39f4544c',
        isSidechain: false,
        message: {
          id: 'msg_011Cenbg7NbVdeYxC2Lh2qy6',
          model: 'claude-opus-5',
          role: 'assistant',
          contentTypes: ['thinking'],
          usage: {
            input_tokens: 2,
            output_tokens: 664,
            cache_read_input_tokens: 115229,
            cache_creation_input_tokens: 7682,
          },
        },
      },
    ],
  },
  {
    name: 'no-message-id',
    why: 'Two line kinds that carry no message.id at all — a genuine human user turn and a harness-written system line (a compact_boundary marker) — so the id must have a fallback for lines Anthropic never assigned a response id to.',
    conversationId: 'ad08132f-1f3b-4ebb-8b55-d276154a79a0',
    file: 'transcript',
    lines: [
      {
        lineNo: 6,
        type: 'user',
        uuid: 'd96300b2-35f2-4bbf-8a07-6ae9bf530540',
        timestamp: '2026-09-05T16:38:56.098Z',
        sessionId: 'ad08132f-1f3b-4ebb-8b55-d276154a79a0',
        isSidechain: false,
        message: {
          role: 'user',
          contentTypes: ['text'],
        },
      },
      {
        lineNo: 2992,
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'd62d187b-0ff9-47e8-aa2f-fdb04c14f9b0',
        timestamp: '2026-09-06T18:01:13.759Z',
        sessionId: 'ad08132f-1f3b-4ebb-8b55-d276154a79a0',
        isSidechain: false,
      },
    ],
  },
  {
    name: 'subagent-transcript',
    why: 'Lines from a subagent transcript (subagents/agent-*.jsonl, isSidechain true) — a full turn (thinking, then text, then tool_use, ALL sharing one message.id) followed by its tool_result, which must derive ids consistently even though these lines never appear in the parent transcript at all.',
    conversationId: '731e8d13-db8a-465b-81fc-3c520aba76d4',
    file: 'subagent',
    lines: [
      {
        lineNo: 5,
        type: 'assistant',
        uuid: 'ab71698b-dd4a-4465-a8c3-a575fc705727',
        timestamp: '2026-09-04T14:58:43.827Z',
        sessionId: '731e8d13-db8a-465b-81fc-3c520aba76d4',
        isSidechain: true,
        message: {
          id: 'msg_011Ceiba76JP2Vb57iZZW2tU',
          model: 'claude-haiku-4-5-20251001',
          role: 'assistant',
          contentTypes: ['thinking'],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 18915,
            cache_creation_input_tokens: 59365,
          },
        },
      },
      {
        lineNo: 6,
        type: 'assistant',
        uuid: '9f52dde6-dd7a-40f1-afb7-ff013bd6a0f0',
        timestamp: '2026-09-04T14:58:44.089Z',
        sessionId: '731e8d13-db8a-465b-81fc-3c520aba76d4',
        isSidechain: true,
        message: {
          id: 'msg_011Ceiba76JP2Vb57iZZW2tU',
          model: 'claude-haiku-4-5-20251001',
          role: 'assistant',
          contentTypes: ['text'],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 18915,
            cache_creation_input_tokens: 59365,
          },
        },
      },
      {
        lineNo: 7,
        type: 'assistant',
        uuid: '3f116a7d-09cd-4e33-8771-af76186e81aa',
        timestamp: '2026-09-04T14:58:44.487Z',
        sessionId: '731e8d13-db8a-465b-81fc-3c520aba76d4',
        isSidechain: true,
        message: {
          id: 'msg_011Ceiba76JP2Vb57iZZW2tU',
          model: 'claude-haiku-4-5-20251001',
          role: 'assistant',
          contentTypes: ['tool_use'],
          toolUseIds: ['toolu_01V3Mcn4iVTU5Qxd3vLmcG77'],
          toolNames: ['Read'],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 18915,
            cache_creation_input_tokens: 59365,
          },
        },
      },
      {
        lineNo: 8,
        type: 'user',
        uuid: '5953b8a8-cc14-4481-917c-cd0fe611549f',
        timestamp: '2026-09-04T14:58:44.503Z',
        sessionId: '731e8d13-db8a-465b-81fc-3c520aba76d4',
        isSidechain: true,
        message: {
          role: 'user',
          contentTypes: ['tool_result'],
        },
      },
    ],
  },
  {
    name: 'tool-result-user-line',
    why: 'A user-role line whose content is a tool_result block — the reply to a tool_use, carrying no message.id of its own — which the id must derive from what it CAN see (the surrounding structure) rather than a response id that does not exist here.',
    conversationId: 'f803d279-c0cb-4ce9-8847-c1d130ef76eb',
    file: 'transcript',
    lines: [
      {
        lineNo: 45,
        type: 'user',
        uuid: 'bf0cc3ad-1f22-43c3-8912-466b334a0616',
        timestamp: '2026-09-11T20:59:23.826Z',
        sessionId: 'f803d279-c0cb-4ce9-8847-c1d130ef76eb',
        isSidechain: false,
        message: {
          role: 'user',
          contentTypes: ['tool_result'],
        },
      },
    ],
  },
]
