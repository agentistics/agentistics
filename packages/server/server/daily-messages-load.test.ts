import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The repair must run on the way IN: an inflated record in the store (days sum above its lifetime
 * counters, written before 2026-11-27) is read back apportioned, through `loadConsolidated`.
 * A test of `repairDailyMessages` alone does not notice the call being removed from the reader.
 */
const SCRIPT = `
import { loadConsolidated, consolidatedPath } from './consolidate'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const day = (messages: number) => ({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages })
const rec = {
  session_id: 'inflated', harness: 'claude', project_path: '/p', start_time: '2026-10-01T00:00:00Z',
  user_message_count: 2, assistant_message_count: 3,
  daily: { '2026-10-01': day(6), '2026-10-02': day(9) },
} as any
const p = consolidatedPath('claude', 'inflated')
mkdirSync(dirname(p), { recursive: true })
writeFileSync(p, JSON.stringify(rec))
const s = (await loadConsolidated()).get('inflated')!
console.log(JSON.stringify(Object.values(s.daily!).map((d: any) => d.messages)))
`

test('a stored record with inflated daily messages is apportioned to its lifetime when loaded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daily-load-'))
  try {
    const script = join(import.meta.dir, `.daily-load-${process.pid}.ts`)
    await Bun.write(script, SCRIPT)
    try {
      const p = Bun.spawnSync([process.execPath, script], { env: { ...process.env, HOME: home, AGENTISTICS_DIR: join(home, '.agentistics') }, cwd: import.meta.dir })
      const lines = p.stdout.toString().trim().split('\n')
      const days = JSON.parse(lines[lines.length - 1]!) as number[]
      expect(days.reduce((a, b) => a + b, 0)).toBe(5) // 2 + 3, not 15
      expect(days).toEqual([2, 3])
    } finally { rmSync(script, { force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
