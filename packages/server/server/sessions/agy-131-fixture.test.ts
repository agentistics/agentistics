import { describe, expect, it } from 'bun:test'
import { parseAntigravityChat } from './antigravity-chat'
import { agyLogFromFds, agyLogWorkspaces, conversationFromAgyLog } from './agy-conversation'

/**
 * agy 1.3.1 (language server 1.3.0), captured 2026-10-07 from a session agentop started in a
 * throwaway HOME: no first prompt, "hello" typed from the web chat, then a shell command that needed
 * approval. Long `content` bodies are cut; every key and type is as agy wrote it. Pinned because the
 * real-user report ("the CLI answers, the chat never shows it") was on this version.
 */
const LOG = [
  'I1007 12:28:49.400250       1 server.go:323] Creating CLI server backend: product=antigravity workspaceDirs=[/tmp/p/proj] appDataDir=/tmp/h/.gemini/antigravity-cli cascadeManager=…',
  'I1007 12:30:01.251158     610 server.go:1263] Created conversation 8fb1f988-8e02-4f63-8d57-3b85829e447c',
  'I1007 12:30:01.253000     610 server.go:3136] GetConversationDetail: found conversation 8fb1f988-8e02-4f63-8d57-3b85829e447c (active=true)',
].join('\n')

const TRANSCRIPT = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-07T15:30:01Z', content: '<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-07T12:30:01-03:00.\n</ADDITIONAL_METADATA>' },
  { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-07T15:30:01Z', input_tokens: 11868, cache_read_tokens: 0, output_tokens: 62, content: 'Hello! How can I help you today?' },
  { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-07T15:32:44Z', content: '<USER_REQUEST>\nRun the shell command: echo agytest > out.txt and then tell me done\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n…\n</ADDITIONAL_METADATA>' },
  { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-07T15:32:44Z', input_tokens: 2754, cache_read_tokens: 9258, output_tokens: 247, thinking: '**Executing Command**\n\nI\'ve just executed the command.\n\n', tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo agytest > out.txt', Cwd: '/tmp/p/proj', WaitMsBeforeAsync: 2000, toolAction: 'Writing to out.txt', toolSummary: 'Run echo command' } }] },
  // 1.3.1 writes the EXECUTION as `GENERIC` (1.1.x wrote `RUN_COMMAND`): still not a chat turn.
  { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-07T15:32:47Z', content: 'Created At: …\n\nThe command exited with code 0.\nStdout:\n\nStderr:\n\n' },
  { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-07T15:33:33Z', input_tokens: 12321, cache_read_tokens: 0, output_tokens: 20, content: 'done' },
].map(o => JSON.stringify(o))

describe('agy 1.3.1 — the conversation link', () => {
  it('reads the created conversation and the workspace off the 1.3.1 log', () => {
    expect(conversationFromAgyLog(LOG)).toBe('8fb1f988-8e02-4f63-8d57-3b85829e447c')
    expect(agyLogWorkspaces(LOG)).toContain('/tmp/p/proj')
  })
  it('finds the log among the fds the pane process holds (stdout+stderr, plus a crash log)', () => {
    expect(agyLogFromFds([
      '/tmp/h/.gemini/antigravity-cli/log/cli-20261007_122849.log',
      '/tmp/h/.gemini/antigravity-cli/crashes/crash_436838_595b954c-4bcf-4736-b90f-bafdd30c7f18.log',
      '/tmp/h/.gemini/antigravity-cli/log/cli-20261007_122849.log',
    ])).toBe('/tmp/h/.gemini/antigravity-cli/log/cli-20261007_122849.log')
  })
})

describe('agy 1.3.1 — the chat', () => {
  const turns = parseAntigravityChat(TRANSCRIPT)
  it('draws the person, the replies and the tool request — never the GENERIC execution', () => {
    expect(turns.map(t => [t.role, t.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hello! How can I help you today?'],
      ['user', 'Run the shell command: echo agytest > out.txt and then tell me done'],
      ['assistant', ''],
      ['assistant', 'done'],
    ])
    expect(turns[3]!.tools?.[0]).toMatchObject({ name: 'run_command', canonical: 'Bash', detail: 'echo agytest > out.txt' })
  })
})
