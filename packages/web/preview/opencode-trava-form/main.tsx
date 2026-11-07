/**
 * Dev-only fixture for OPENCODE.TRAVA-FORM — what the owner's print showed, drawn by the real components with OpenCode-shaped data:
 * tool rows with the command (B2), the reasoning line live and done (B4), and a composer whose Enter / Cmd+Enter report what they do (B3).
 * No server, no HOME data. `?theme=light` for the light theme.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { ToolActivity } from '../../src/components/sessions/ToolActivity'
import { ReasoningRow } from '../../src/components/sessions/ReasoningRow'
import { enterSends } from '../../src/lib/composerEnter'
import { groupPerExchange, markTrailingRunning, stepsOfTurn, type TurnLike } from '../../src/lib/toolActivity'
import { useIsMobile } from '../../src/hooks/useIsMobile'

/**
 * QA HIGH-1 + MED-1 — the receiver's turns RECORDED from the real opencode 1.19.5 (opencode/deepseek-v4.1-flash-free, throwaway
 * HOME, quiet notice at 15 s), prompt "echo start-out; sleep 30; echo hello-out; ls /nonexistent-dir". Two moments: 21 s in
 * (the notice has just landed while the command runs) and the end. Before the fix the notice vanished at the next update and a
 * ghost "Executando…" step stood beside the settled one.
 */
const CMD = 'echo start-out; sleep 30; echo hello-out; ls /nonexistent-dir'
const USER: TurnLike = { role: 'user', text: `Run this exact shell command with the bash tool: ${CMD} . Then tell me in one sentence what it printed.`, at: '2026-11-07T02:29:00.000Z' }
const NOTICE: TurnLike = { role: 'assistant', text: `Sem resposta do OpenCode há 15 s (último passo: ${CMD}). Pode ser um comando demorado ou o provedor parado — se não for o caso, use Parar.`, at: '2026-11-07T02:29:21.000Z' }
const realMid: TurnLike[] = [USER, { role: 'assistant', text: '', at: '2026-11-07T02:29:04.800Z', pending: true, tools: [{ name: 'bash', canonical: 'execute', detail: CMD, ref: 'call_1', output: 'start-out' }] }, NOTICE]
const realEnd: TurnLike[] = [USER,
  { role: 'assistant', text: '', at: '2026-11-07T02:29:04.800Z', tools: [{ name: 'bash', canonical: 'execute', detail: CMD, failed: true, ref: 'call_1', output: "start-out\nhello-out\nls: cannot access '/nonexistent-dir': No such file or directory" }] },
  NOTICE,
  { role: 'assistant', text: 'It printed `start-out`, then after 30 seconds `hello-out`, then an `ls` error saying `/nonexistent-dir: No such file or directory`.', at: '2026-11-07T02:29:40.100Z' },
]
function Chat({ turns, working }: { turns: TurnLike[]; working: boolean }) {
  const items = markTrailingRunning(groupPerExchange(turns), working)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => it.type === 'activity'
        ? <div key={i} data-item="activity"><ToolActivity variant="live" lang="pt" group={it.group} now={Date.parse('2026-11-07T02:29:25Z')} /></div>
        : <div key={i} data-item={it.turn.role} style={{
            alignSelf: it.turn.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '86%', fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere',
            padding: '6px 10px', borderRadius: 10, background: it.turn.role === 'user' ? 'var(--bg-elevated)' : 'transparent',
            border: it.turn.role === 'user' ? '1px solid var(--border)' : 'none',
          }}>{it.turn.text}</div>)}
    </div>
  )
}

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark'

// The frames the engine now produces for opencode 1.19.5 (bash): canonical is the ACP kind, detail is the command.
const running = stepsOfTurn({ role: 'assistant', text: '', pending: true, tools: [
  { name: 'bash', canonical: 'execute', detail: 'sleep 3; printf hello-out; echo err >&2', ref: 'c1' },
] })
const many = stepsOfTurn({ role: 'assistant', text: '', tools: [
  { name: 'bash', canonical: 'execute', detail: 'git status --short', ref: 'a' },
  { name: 'read', canonical: 'read', detail: '/w/src/index.ts', ref: 'b' },
  { name: 'bash', canonical: 'execute', detail: 'bun test packages/core', failed: true, ref: 'c' },
  { name: 'grep', canonical: 'search', detail: 'TODO', ref: 'd' },
] })
const before = stepsOfTurn({ role: 'assistant', text: '', pending: true, tools: Array.from({ length: 7 }, (_, i) => ({ name: 'execute', canonical: 'execute', ref: `x${i}` })) })

function Composer() {
  const isMobile = useIsMobile()
  const [log, setLog] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  return (
    <div>
      <textarea
        data-testid="composer" value={draft} onChange={e => setDraft(e.target.value)} rows={2}
        style={{ width: '100%', fontSize: 16, background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}
        onKeyDown={e => {
          if (enterSends({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode, isMobile })) {
            e.preventDefault(); setLog(l => [...l, `sent: ${draft}`]); setDraft('')
          }
        }}
      />
      <pre data-testid="log" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{log.join('\n') || '(nothing sent)'}</pre>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 20, maxWidth: 940, margin: '0 auto', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 18 }}>
    <h1 style={{ fontSize: 18 }}>OpenCode: o que aparece agora</h1>
    <section data-case="real-mid"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Real (opencode 1.19.5) — comando rodando, aviso de silêncio chegou</h2>
      <Chat turns={realMid} working /></section>
    <section data-case="real-end"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Real (opencode 1.19.5) — concluído: comando + saída, aviso, resposta</h2>
      <Chat turns={realEnd} working={false} /></section>
    <section data-case="before"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Antes (sem comando, tipo desconhecido virava “outra ferramenta”)</h2>
      <ToolActivity variant="live" lang="pt" group={{ key: 'before', steps: before.map(s => ({ ...s, kind: 'other' as const })), running: true, startedAt: new Date(Date.now() - 94 * 60_000).toISOString() }} /></section>
    <section data-case="running"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Agora — comando em execução</h2>
      <ToolActivity variant="live" lang="pt" group={{ key: 'running', steps: running, running: true, startedAt: new Date(Date.now() - 12_000).toISOString() }} /></section>
    <section data-case="finished"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Agora — passos concluídos, um falhou</h2>
      <ToolActivity variant="inline" lang="pt" defaultOpen group={{ key: 'many', steps: many, running: false, startedAt: '2026-11-06T17:55:00Z', endedAt: '2026-11-06T17:56:20Z' }} /></section>
    <section data-case="reasoning-live"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Raciocínio — ao vivo</h2>
      <ReasoningRow lang="pt" running text="Vou conferir a documentação antes de responder." clock={{ startedAt: Date.now() - 12_000, endedAt: null }} /></section>
    <section data-case="reasoning-done"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Raciocínio — concluído</h2>
      <ReasoningRow lang="pt" running={false} text="Vou conferir a documentação antes de responder." clock={{ startedAt: 1000, endedAt: 19_000 }} /></section>
    <section data-case="composer"><h2 style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Compositor — Enter / Cmd+Enter</h2><Composer /></section>
  </main>,
)
