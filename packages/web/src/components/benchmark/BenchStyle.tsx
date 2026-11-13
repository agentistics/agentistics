/**
 * The Benchmark screen's own CSS — layout rules that need a media query (the prototype's `@media` block:
 * list above hero, 2-column type tiles, task rows as cards, buckets as stacked facts). Everything else is
 * inline. Scoped by the `bm-` prefix; colours are the app's tokens, the tone ones are set per element.
 */
import React from 'react'

export const TONE_VAR: Record<'good' | 'bad' | 'tie' | 'none', string> = {
  good: 'var(--accent-green)', bad: 'var(--accent-red)', tie: 'var(--accent-amber, #fbbf24)', none: 'var(--text-tertiary)',
}

const CSS = `
.bm-top{display:grid;grid-template-columns:240px minmax(0,1fr);gap:12px;align-items:start}
.bm-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.bm-types{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.bm-buckets{display:grid;grid-template-columns:110px repeat(6,minmax(0,1fr));font-size:12.5px}
.bm-buckets>div{padding:6px 8px 6px 0;border-top:1px solid var(--border);min-width:0}
.bm-buckets>.bm-h{border:0;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-tertiary);font-weight:600}
.bm-tasks{width:100%;border-collapse:collapse;font-size:12.5px}
.bm-tasks th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-tertiary);font-weight:600;padding:6px 10px 6px 0;white-space:nowrap}
.bm-tasks td{padding:8px 10px 8px 0;border-top:1px solid var(--border);vertical-align:top}
.bm-tasks td.bm-num,.bm-tasks th.bm-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bm-tasks tr.bm-t{cursor:pointer}.bm-tasks tr.bm-t:hover td{background:rgba(127,127,127,.05)}
.bm-tasks th button{all:unset;cursor:pointer}
.bm-tasks td.bm-d{white-space:normal;color:var(--text-secondary);font-size:12px;background:rgba(127,127,127,.04);padding:10px}
@media (max-width:1100px){.bm-types{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:700px){
 .bm-top{grid-template-columns:minmax(0,1fr)}
 .bm-types{grid-template-columns:repeat(2,minmax(0,1fr))}
 .bm-word,.bm-score{font-size:27px!important}
 .bm-tasks thead{display:none}
 .bm-tasks,.bm-tasks tbody{display:block}
 .bm-tasks tr.bm-t{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;padding:9px 0;border-top:1px solid var(--border)}
 .bm-tasks tr.bm-t td{border:0;padding:1px 0;white-space:normal}
 .bm-tasks tr.bm-t td:first-child{grid-column:1/3;font-weight:600}
 .bm-tasks tr.bm-t td.bm-num{text-align:left}
 .bm-tasks tr.bm-t td.bm-cp{grid-column:1/3;padding-top:4px}
 .bm-tasks td[data-l]:not(.bm-cp)::before{content:attr(data-l) ": ";color:var(--text-tertiary)}
 .bm-tasks tr.bm-d,.bm-tasks tr.bm-d td{display:block}
 .bm-buckets{grid-template-columns:repeat(3,minmax(0,1fr))}
 .bm-buckets>.bm-h{display:none}
 .bm-buckets>div{border:0;padding:2px 0}
 .bm-buckets>div.bm-k{grid-column:1/4;border-top:1px solid var(--border);padding-top:8px;font-weight:600}
 .bm-buckets>div[data-l]::before{content:attr(data-l) ": ";color:var(--text-tertiary);font-size:11px}
 .bm-btn{min-height:44px}
}`

export function BenchStyle() { return <style>{CSS}</style> }

/** The prototype's bar: a track, a fill in the tone, and the zero mark at 50 when `mark` is set. */
export function Bar({ value, tone, big = false, mark = true }: { value: number; tone: keyof typeof TONE_VAR | 'rate'; big?: boolean; mark?: boolean }) {
  const h = big ? 16 : 8, color = tone === 'rate' ? 'var(--accent-cyan, var(--accent-blue))' : TONE_VAR[tone]
  return <div role="img" aria-label={`${Math.round(value)}%`} style={{ position: 'relative', height: h, borderRadius: h / 2, background: 'rgba(127,127,127,.2)', marginTop: big ? 12 : 4 }}>
    <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(0, Math.min(100, value))}%`, borderRadius: h / 2, background: color }} />
    {mark && <i style={{ position: 'absolute', left: '50%', top: big ? -4 : -3, bottom: big ? -4 : -3, width: 2, marginLeft: -1, background: 'var(--text-primary)' }} />}
  </div>
}
