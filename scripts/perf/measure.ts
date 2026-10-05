/**
 * scripts/perf/measure.ts — measurements shared by `baseline.ts` and `budget.ts` (PERF.1).
 */
import { quantiles, type PerfServer } from './server-harness.ts'

/** Send → echo and harness write → shown, over the chat stream; null when the server has no stream. */
export async function measurePush(s: PerfServer, id: string, rounds = 6): Promise<PushNumbers | null> {
  const ctl = new AbortController()
  const res = await fetch(`${s.base}/api/fleet/chat-stream?id=${id}&lang=en`, { signal: ctl.signal }).catch(() => null)
  if (!res || res.status !== 200 || !res.body) return null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames: { at: number; data: string }[] = []
  let first = NaN
  const t0 = performance.now()
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        buf += dec.decode(r.value)
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          if (/^event: chat(-delta)?$/m.test(block)) { if (Number.isNaN(first)) first = performance.now() - t0; frames.push({ at: Date.now(), data: block }) }
        }
      }
    } catch { /* aborted */ }
  })()
  for (let i = 0; i < 100 && Number.isNaN(first); i++) await Bun.sleep(20)
  // The in-flight text: the terminal stream the chat scrapes for the turn being written.
  const term: { at: number; data: string }[] = []
  const tres = await fetch(`${s.base}/api/fleet/stream?id=${id}`, { signal: ctl.signal }).catch(() => null)
  if (tres?.body) {
    const tr = tres.body.getReader()
    const td = new TextDecoder()
    void (async () => { try { for (;;) { const r = await tr.read(); if (r.done) break; term.push({ at: Date.now(), data: td.decode(r.value) }) } } catch { /* aborted */ } })()
  }
  const echo: number[] = [], answer: number[] = [], inflight: number[] = []
  for (let k = 0; k < rounds; k++) {
    const marker = `pushmark${k}x${Date.now()}`
    const tSend = Date.now()
    const from = frames.length
    await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'prompt', text: marker }) })
    const deadline = Date.now() + 15_000
    let e = false, a = false
    while ((!e || !a) && Date.now() < deadline) {
      for (const f of frames.slice(from)) {
        if (!e && f.data.includes(`${marker} writtenAt=`)) {
          echo.push(f.at - tSend); e = true
          // the harness starts printing the answer right after it writes the user turn
          const userAt = Number(f.data.match(new RegExp(`${marker} writtenAt=(\\d+)`))?.[1])
          const shown = term.find(t => t.data.includes(`answer to ${marker}`))
          if (shown && userAt) inflight.push(shown.at - userAt)
          else if (userAt) void (async () => { for (let w = 0; w < 300; w++) { const t2 = term.find(t => t.data.includes(`answer to ${marker}`)); if (t2) { inflight.push(t2.at - userAt); return } await Bun.sleep(5) } })()
        }
        const m = f.data.match(new RegExp(`answer to ${marker}[^"]*writtenAt=(\\d+)`))
        if (!a && m) { answer.push(f.at - Number(m[1])); a = true }
      }
      await Bun.sleep(5)
    }
    await Bun.sleep(300)
  }
  ctl.abort()
  return { firstFrameMs: Math.round(first), echoByRound: echo, answerByRound: answer, sendToEcho: quantiles(echo), harnessWriteToShown: quantiles(answer), inflightTextShown: quantiles(inflight) }
}


export interface PushNumbers {
  firstFrameMs: number
  /** Every round's own figure, in order, so a slow one is visible as a round and not hidden in a p95 of three. */
  echoByRound: number[]
  answerByRound: number[]
  sendToEcho: ReturnType<typeof quantiles>
  harnessWriteToShown: ReturnType<typeof quantiles>
  inflightTextShown: ReturnType<typeof quantiles>
}
