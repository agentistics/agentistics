// RES.1 measurement: drive the cockpit host the way the mounted TUI does and watch memory.
import { createControlHost } from '../server/cli-start'
const fakeAlt = { enter() {}, leave() {}, suspend: async <T>(fn: () => Promise<T>) => fn(), active: () => false } as any
const host = createControlHost('en', fakeAlt)
{ Bun.gc(true); const m = process.memoryUsage(); console.log(`after-import rss=${(m.rss/1048576).toFixed(1)} heap=${(m.heapUsed/1048576).toFixed(1)}`) }
const N = Number(process.env.N ?? 150)
const mode = process.env.MODE ?? 'sessions'
const mb = (b: number) => (b / 1048576).toFixed(1)
for (let i = 0; i <= N; i++) {
  if (mode.includes('sessions')) await host.sessions!()
  if (mode.includes('refresh')) await host.refresh()
  if (i % 25 === 0) {
    Bun.gc(true)
    const m = process.memoryUsage()
    console.log(`i=${i} rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} external=${mb(m.external)}`)
  }
}
process.exit(0)
