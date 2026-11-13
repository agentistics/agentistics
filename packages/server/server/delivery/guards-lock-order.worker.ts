/**
 * Worker for guards-lock-order.test.ts — one process of the two-process race.
 * argv: <dir> <role: board|tick> <iterations>
 * `board` takes tasks → deliveries → guards (a board-raising write), `tick` takes deliveries → guards.
 * Each iteration does a read-modify-write of a counter file per lock it holds; a lost update or an overlap
 * shows up as a counter lower than the iteration total, or as the overlap marker being seen.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GuardBusy, withGuardLocks } from './guard-locks'

const [dir, role, itersArg] = process.argv.slice(2) as [string, 'board' | 'tick', string]
const iters = Number(itersArg)
const paths = { tasks: join(dir, 'tasks.json'), deliveries: join(dir, 'deliveries.json'), guards: join(dir, 'guards.json') }
const bump = (f: string, who: string) => {
  const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
  writeFileSync(f, String(n + 1))
  appendFileSync(join(dir, `${who}.log`), '.')
}
const marker = join(dir, 'inside.marker')

let busy = 0
for (let i = 0; i < iters; i++) {
  for (;;) {
    try {
      await withGuardLocks(role === 'board' ? ['tasks', 'deliveries', 'guards'] : ['deliveries', 'guards'], async () => {
        // the shared critical section is `guards`: nobody else may be in it at the same time
        if (existsSync(marker)) appendFileSync(join(dir, 'overlap.log'), `${role}:${i}\n`)
        writeFileSync(marker, role)
        if (role === 'board') bump(join(dir, 'tasks.count'), role)
        bump(join(dir, 'deliveries.count'), role)
        await new Promise(r => setTimeout(r, 1))
        bump(join(dir, 'guards.count'), role)
        const { unlinkSync } = await import('node:fs')
        unlinkSync(marker)
      }, { paths })
      break
    } catch (e) {
      if (e instanceof GuardBusy) { busy++; continue }
      throw e
    }
  }
}
writeFileSync(join(dir, `${role}.done`), JSON.stringify({ busy }))
