/**
 * scripts/perf/measure.ts — measurements shared by `baseline.ts` and `budget.ts` (PERF.1).
 */
import { quantiles, type PerfServer } from './server-harness.ts'
import { liveAnswerText } from '../../packages/web/src/lib/liveAnswer.ts'
import { stripAnsi } from '../../packages/web/src/lib/liveTurn.ts'

/**
 * STREAM.FIX: what the CHAT would draw as the answer being written, frame by frame — the page's own
 * reader (`liveAnswerText`) over the terminal frames the page receives. Before this, the budgets
 * measured that frames reached the server's stream and never that the chat could make an answer
 * out of them, which is how "vem tudo de uma vez" passed every figure here.
 */
export function inflightSteps(frames: readonly { at: number; content: string }[], marker: string, until: number): { steps: number; firstAt: number | null } {
  let longest = 0, steps = 0, firstAt: number | null = null
  for (const f of frames) {
    if (f.at >= until) break
    const t = liveAnswerText({ harness: 'claude', working: true, lines: stripAnsi(f.content).split('\n') })
    if (!t || !t.includes(`answer to ${marker}`)) continue
    if (t.length > longest) { longest = t.length; steps++; firstAt ??= f.at }
  }
  return { steps, firstAt }
}

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
  const termFrames: { at: number; content: string }[] = []
  const tres = await fetch(`${s.base}/api/fleet/stream?id=${id}`, { signal: ctl.signal }).catch(() => null)
  if (tres?.body) {
    const tr = tres.body.getReader()
    const td = new TextDecoder()
    let tbuf = ''
    void (async () => {
      try {
        for (;;) {
          const r = await tr.read(); if (r.done) break
          const chunk = td.decode(r.value)
          const at = Date.now()
          term.push({ at, data: chunk })
          tbuf += chunk
          let j: number
          while ((j = tbuf.indexOf('\n\n')) >= 0) {
            const block = tbuf.slice(0, j); tbuf = tbuf.slice(j + 2)
            if (!/^event: frame$/m.test(block)) continue
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
            try { const v = JSON.parse(data) as { content?: unknown }; if (typeof v.content === 'string') termFrames.push({ at, content: v.content }) } catch { /* partial */ }
          }
        }
      } catch { /* aborted */ }
    })()
  }
  const echo: number[] = [], answer: number[] = [], inflight: number[] = [], growth: number[] = [], liveFirst: number[] = []
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
        if (!a && m) {
          answer.push(f.at - Number(m[1])); a = true
          // How many times the chat's live answer GREW before the finished turn arrived.
          const g = inflightSteps(termFrames, marker, f.at)
          growth.push(g.steps)
          if (g.firstAt !== null) liveFirst.push(g.firstAt - tSend)
        }
      }
      await Bun.sleep(5)
    }
    await Bun.sleep(300)
  }
  ctl.abort()
  return { firstFrameMs: Math.round(first), echoByRound: echo, answerByRound: answer, sendToEcho: quantiles(echo), harnessWriteToShown: quantiles(answer), inflightTextShown: quantiles(inflight), inflightGrowthSteps: growth, sendToLiveAnswer: quantiles(liveFirst) }
}


export interface PushNumbers {
  firstFrameMs: number
  /** Every round's own figure, in order, so a slow one is visible as a round and not hidden in a p95 of three. */
  echoByRound: number[]
  answerByRound: number[]
  sendToEcho: ReturnType<typeof quantiles>
  harnessWriteToShown: ReturnType<typeof quantiles>
  inflightTextShown: ReturnType<typeof quantiles>
  /** Per round: how many times the chat's live answer grew before the finished turn arrived. */
  inflightGrowthSteps: number[]
  /** Send → the chat first has a live answer to draw. */
  sendToLiveAnswer: ReturnType<typeof quantiles>
}
