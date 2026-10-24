/** Dev-only fixture of real activity/system rows. No server or real HOME data needed. */
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { ToolActivity, type ToolActivityVariant } from '../../src/components/sessions/ToolActivity'
import { SystemEventRow } from '../../src/components/sessions/ChatBubble'
import { stepsOfTurn } from '../../src/lib/toolActivity'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark'
const runs = [
  ['Comandos', ['Bash', 'Bash']],
  ['MCP · logo local', ['mcp__agentistics__agentistics_tasks']],
  ['MCP · sem logo', ['mcp__unknown__list_tools']],
  ['Misto · 2 comandos e 1 MCP', ['Bash', 'mcp__agentistics__agentistics_tasks', 'Bash']],
] as const

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 20, maxWidth: 940, margin: '0 auto', color: 'var(--text-primary)' }}>
    <h1 style={{ fontSize: 18, marginBottom: 20 }}>Atividade no chat</h1>
    {(['live', 'inline', 'divider'] as ToolActivityVariant[]).map(variant => <section key={variant} style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-secondary)' }}>{variant}</h2>
      {runs.map(([title, names]) => <div key={title} data-case={title} style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>{title}</div>
        <ToolActivity variant={variant} lang="pt" group={{ key: title, steps: stepsOfTurn({ role: 'assistant', text: '', tools: names.map(name => ({ name })) }), running: false, startedAt: '2026-10-24T10:00:00Z', endedAt: '2026-10-24T10:00:37Z' }} />
        <SystemEventRow event={{ kind: 'handback', body: 'Implementação concluída.' }} pt />
      </div>)}
    </section>)}
  </main>,
)
