/**
 * Run as a CHILD by hardening.test.ts. `harden` applies the real §5.3 steps through bun:ffi; `plain`
 * does not (the control). Then it checks that the /proc/self reads the service relies on still work,
 * prints one JSON line, and waits to be probed / killed.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { applyHardening, loadLibc, readYamaFile } from '../hardening'

const mode = process.argv[2]
const report = mode === 'harden' ? applyHardening('linux', await loadLibc('linux'), readYamaFile) : null
const selfReads: Record<string, boolean> = {}
for (const [k, f] of [['stat', () => readFileSync('/proc/self/stat', 'utf8')], ['mountinfo', () => readFileSync('/proc/self/mountinfo', 'utf8')], ['limits', () => readFileSync('/proc/self/limits', 'utf8')], ['readdir', () => readdirSync('/proc/self')]] as const) {
  try { f(); selfReads[k] = true } catch { selfReads[k] = false }
}
process.stdout.write(JSON.stringify({ pid: process.pid, report, selfReads }) + '\n')
setInterval(() => {}, 1 << 30)
