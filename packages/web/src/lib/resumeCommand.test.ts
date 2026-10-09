import { test, expect } from 'bun:test'
import { resumeCommand } from './resumeCommand'
import type { SessionMeta, HarnessId } from '@agentistics/core'

function s(harness: HarnessId): SessionMeta {
  return { session_id: 'abc-123', project_path: '/home/u/proj', harness } as SessionMeta
}

test('claude yields cd + claude --resume', () => {
  expect(resumeCommand(s('claude'))).toBe("cd '/home/u/proj' && claude --resume abc-123")
})

test('every harness with a verified resume syntax gets a command', () => {
  // Each of these is taken from the tool's own --help, not guessed.
  expect(resumeCommand(s('antigravity'))).toBe("cd '/home/u/proj' && agy --conversation abc-123")
  expect(resumeCommand(s('codex'))).toBe("cd '/home/u/proj' && codex resume abc-123")
  expect(resumeCommand(s('copilot'))).toBe("cd '/home/u/proj' && copilot --resume abc-123")
  expect(resumeCommand(s('kimi'))).toBe("cd '/home/u/proj' && kimi -S abc-123")
})

test('gemini resumes by the chat header UUID, never by the store key', () => {
  // The store key is the synthetic `<project>/<file>`; `gemini --resume` takes the header's UUID.
  const g = { session_id: 'proj/session-2026-10-09T10-49-04d97770', native_session_id: '04d97770-e53f-4b7d-86d2-63bd12ec32eb',
    project_path: '/home/u/proj', harness: 'gemini' } as SessionMeta
  expect(resumeCommand(g)).toBe("cd '/home/u/proj' && gemini --resume 04d97770-e53f-4b7d-86d2-63bd12ec32eb")
})

test('a gemini session recorded without a header id yields null rather than a wrong command', () => {
  // Passing the synthetic key (or an index, which shifts) would reopen nothing or a neighbour.
  expect(resumeCommand(s('gemini'))).toBeNull()
})

test('a session with no id yields null rather than a broken command', () => {
  expect(resumeCommand({ session_id: '', project_path: '/p', harness: 'claude' } as SessionMeta)).toBeNull()
})

test('without project_path the command runs in place, with no cd', () => {
  const noPath = { session_id: 'x', project_path: '', harness: 'claude' } as SessionMeta
  expect(resumeCommand(noPath)).toBe('claude --resume x')
  const agy = { session_id: 'y', project_path: '', harness: 'antigravity' } as SessionMeta
  expect(resumeCommand(agy)).toBe('agy --conversation y')
})
