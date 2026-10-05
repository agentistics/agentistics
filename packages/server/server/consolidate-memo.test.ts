import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The memo lives in module state and CONSOLIDATED_DIR is fixed at import, so the scenario runs in
// a child process over a throwaway HOME.
const SCRIPT = `
import { writeConsolidated, loadConsolidated, consolidatedPath } from './consolidate'
import { writeFileSync, utimesSync } from 'node:fs'
const base = { session_id: 's1', harness: 'claude', project_path: '/p', start_time: '2026-10-01T00:00:00Z', input_tokens: 1, output_tokens: 1 } as any
const out: unknown[] = []
out.push(await writeConsolidated([base]))
out.push(await writeConsolidated([base]))           // unchanged: no write
const a = await loadConsolidated()
a.get('s1')!.git_remote = 'mutated'                  // a caller stamping its copy
const b = await loadConsolidated()
out.push(b.get('s1')!.git_remote ?? null)           // the remembered record is untouched
const p = consolidatedPath('claude', 's1')
writeFileSync(p, JSON.stringify({ ...base, input_tokens: 99 }))
utimesSync(p, new Date(), new Date(Date.now() + 5000))
out.push((await loadConsolidated()).get('s1')!.input_tokens) // an edit on disk is read again
out.push(await writeConsolidated([base]))           // and a write over it is not skipped
out.push((await loadConsolidated()).get('s1')!.input_tokens)
console.log(JSON.stringify(out))
`

test('the consolidate store remembers by file stamp, hands out copies, and sees edits on disk', async () => {
  const home = mkdtempSync(join(tmpdir(), 'consolidate-memo-'))
  try {
    const script = join(import.meta.dir, `.consolidate-memo-${process.pid}.ts`)
    await Bun.write(script, SCRIPT)
    try {
      const p = Bun.spawnSync(['bun', script], { env: { ...process.env, HOME: home, AGENTISTICS_DIR: join(home, '.agentistics') }, cwd: import.meta.dir })
      const lines = p.stdout.toString().trim().split('\n')
      expect(JSON.parse(lines[lines.length - 1]!)).toEqual([1, 0, null, 99, 1, 1])
    } finally { rmSync(script, { force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
