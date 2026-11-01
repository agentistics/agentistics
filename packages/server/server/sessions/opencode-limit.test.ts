import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opencodeLimitFromLog, readOpencodeLimit } from './opencode-limit'

const S = 'ses_e6f24c17fffe3bzg3zp4CucgJQ'
// Real lines from opencode 1.19.5's log (throwaway HOME, free model, 2026-10-31).
const main = `timestamp=2026-10-31T07:27:32.371Z level=ERROR run=1ca8d413 message="stream error" providerID=opencode modelID=glm-5.3-flash-free session.id=${S} small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"`
const title = `timestamp=2026-10-31T07:27:42.495Z level=ERROR run=1ca8d413 message="stream error" providerID=opencode modelID=glm-5.3-flash-free session.id=${S} small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached."`
const other = main.replace(S, 'ses_other')
const connect = `timestamp=2026-10-31T07:30:00.000Z level=ERROR run=x message="stream error" providerID=ollama modelID=q session.id=${S} small=false agent=build mode=primary error.error="AI_APICallError: Cannot connect to API"`

describe('opencodeLimitFromLog', () => {
  it('reads the main-agent free-limit refusal for this session, cleaned of the SDK prefix', () => {
    expect(opencodeLimitFromLog([main, title].join('\n'), S)).toEqual({
      at: Date.parse('2026-10-31T07:27:32.371Z'),
      message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go',
    })
  })
  it('ignores the title agent, other sessions and errors that are not a limit', () => {
    expect(opencodeLimitFromLog([title, other, connect].join('\n'), S)).toBeNull()
    expect(opencodeLimitFromLog(main, 'ses_e6f2')).toBeNull() // a prefix of the id is not the id
  })
})

describe('readOpencodeLimit', () => {
  const setup = (assistantAfter?: { output: number }) => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-limit-'))
    mkdirSync(join(dir, 'log'))
    writeFileSync(join(dir, 'log', 'opencode.log'), [main, title].join('\n'))
    const dbPath = join(dir, 'opencode.db')
    const db = new Database(dbPath)
    db.run('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
    const at = Date.parse('2026-10-31T07:27:31Z')
    db.run('INSERT INTO message VALUES (?,?,?,?,?)', ['m1', S, at, at, JSON.stringify({ role: 'assistant', tokens: { output: 0 } })])
    if (assistantAfter) {
      const later = Date.parse('2026-10-31T08:00:00Z')
      db.run('INSERT INTO message VALUES (?,?,?,?,?)', ['m2', S, later, later, JSON.stringify({ role: 'assistant', tokens: assistantAfter })])
    }
    db.close()
    return { dir, dbPath }
  }
  it('is in force while nothing was produced after it', () => {
    const { dir, dbPath } = setup()
    try { expect(readOpencodeLimit(S, dbPath)?.message).toStartWith('Free usage limit reached.') } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('clears once a later assistant message produced output', () => {
    const { dir, dbPath } = setup({ output: 12 })
    try { expect(readOpencodeLimit(S, dbPath)).toBeNull() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('answers null for a missing store', () => {
    expect(readOpencodeLimit(S, '/nonexistent/opencode.db')).toBeNull()
  })
})
