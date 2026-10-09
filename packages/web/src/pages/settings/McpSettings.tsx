import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Plug, RefreshCw } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { fetchMcpOverview, useMcpHarness } from '../../hooks/useMcpAuth'
import {
  duplicateNote, mcpStateNote, mcpStateText, type McpHarnessOverview, type McpRow, type McpTone,
} from '../../lib/mcpAuth'
import { SectionHeader, dialogButtonStyle } from './primitives'
import { McpAuthDialog, type McpAuthTarget } from '../../components/McpAuthDialog'
import { CenteredLoader } from '../../components/CenteredLoader'
import { AgentisticsLoader } from '../../components/AgentisticsLoader'

const TONE: Record<McpTone, string> = {
  good: 'var(--accent-green)', warn: 'var(--anthropic-orange)', bad: 'var(--accent-red)', muted: 'var(--text-tertiary)',
}

function StateChip({ row, pt }: { row: McpRow; pt: boolean }) {
  const { text, tone } = mcpStateText(row.state, pt)
  const c = TONE[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
      color: c, background: `color-mix(in srgb, ${c} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`, padding: '2px 8px', borderRadius: 20,
    }}>{text}</span>
  )
}

function ServerRow({ row, harness, pt, isMobile, onAuth }: {
  row: McpRow; harness: McpHarnessOverview; pt: boolean; isMobile: boolean; onAuth: (name: string) => void
}) {
  const note = mcpStateNote(row, harness.label, pt)
  const dup = duplicateNote(row, pt)
  return (
    <div data-testid="mcp-row" data-state={row.state} style={{
      padding: '9px 0', borderTop: '1px solid var(--border-subtle, var(--border))', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>{row.name}</span>
        <StateChip row={row} pt={pt} />
        {row.transport && (
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{row.transport}</span>
        )}
        {row.canAuthenticate && (
          <button type="button" onClick={() => onAuth(row.name)}
            style={{ ...dialogButtonStyle('primary', isMobile), width: isMobile ? '100%' : undefined, marginLeft: isMobile ? 0 : 'auto', flexShrink: 0 }}>
            <Plug size={13} />{pt ? 'Autenticar' : 'Authenticate'}
          </button>
        )}
      </div>
      {row.target && (
        <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere' }}>{row.target}</div>
      )}
      {note && <div style={{ marginTop: 3, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{note}</div>}
      {dup && <div style={{ marginTop: 3, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{dup}</div>}
    </div>
  )
}

function HarnessMcpCard({ h, pt, isMobile, onAuth }: {
  h: McpHarnessOverview; pt: boolean; isMobile: boolean; onAuth: (harness: McpHarnessOverview, server: string) => void
}) {
  const enabled = h.installed && h.canList
  const { status, loading, failed, reload } = useMcpHarness(h.id, enabled)
  const needs = status?.servers.filter(s => s.state === 'needs-auth').length ?? 0

  let badge: { text: string; tone: McpTone } | null = null
  if (!h.installed) badge = { text: pt ? 'Não instalado' : 'Not installed', tone: 'muted' }
  else if (!h.canList) badge = { text: pt ? 'Sem comando MCP' : 'No MCP command', tone: 'muted' }
  else if (status?.kind === 'ok') {
    badge = needs > 0
      ? { text: pt ? `${needs} ${needs === 1 ? 'precisa autenticar' : 'precisam autenticar'}` : `${needs} need${needs === 1 ? 's' : ''} authentication`, tone: 'warn' }
      : { text: status.servers.length === 0 ? (pt ? 'Nenhum servidor' : 'No servers') : `${status.servers.length} ${pt ? (status.servers.length === 1 ? 'servidor' : 'servidores') : (status.servers.length === 1 ? 'server' : 'servers')}`, tone: 'muted' }
  }

  const sentence = !h.installed
    ? (pt ? `O ${h.label} não está instalado nesta máquina. Instale em Configurações → Harnesses.` : `${h.label} is not installed on this machine. Install it in Settings → Harnesses.`)
    : !h.canList ? (h.note ? (pt ? h.note.pt : h.note.en) : null)
      : failed ? (pt ? 'Não consegui falar com esta máquina para ler a lista.' : 'Could not reach this machine to read the list.')
        : status && status.kind !== 'ok' && status.message ? (pt ? status.message.pt : status.message.en)
          : null

  return (
    <div data-testid="mcp-harness-card" data-harness={h.id} style={{
      padding: '14px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{h.label}</span>
        {badge && (() => {
          const c = TONE[badge.tone]
          return (
            <span style={{
              fontSize: 11, fontWeight: 700, color: c, padding: '2px 8px', borderRadius: 20,
              background: `color-mix(in srgb, ${c} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
            }}>{badge.text}</span>
          )
        })()}
        {enabled && (
          <button type="button" onClick={() => reload(true)} disabled={loading}
            aria-label={pt ? 'Atualizar' : 'Refresh'} title={pt ? 'Atualizar' : 'Refresh'}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: isMobile ? 44 : 28, height: isMobile ? 44 : 28, borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', cursor: loading ? 'default' : 'pointer' }}>
            {loading ? <AgentisticsLoader size={13} /> : <RefreshCw size={13} />}
          </button>
        )}
      </div>

      {enabled && loading && !status && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-tertiary)' }} data-testid="mcp-loading">
          {pt ? 'Perguntando ao assistente…' : 'Asking the assistant…'}
        </div>
      )}
      {sentence && <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>{sentence}</div>}

      {status?.kind === 'ok' && status.untrustedFolder && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
          {pt ? 'O Gemini só liga servidores MCP em pastas confiáveis, e esta não é uma — por isso nenhum tem status.' : 'Gemini only turns MCP servers on in trusted folders, and this one is not — so none has a status.'}
        </div>
      )}
      {status?.kind === 'ok' && status.servers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {status.servers.map(row => (
            <ServerRow key={row.name} row={row} harness={h} pt={pt} isMobile={isMobile} onAuth={name => onAuth(h, name)} />
          ))}
        </div>
      )}
      {/* The sentence for a harness whose CLI has servers but no OAuth login — shown once, under the rows. */}
      {status?.kind === 'ok' && status.servers.length > 0 && !h.canAuthenticate && h.note && (
        <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>{pt ? h.note.pt : h.note.en}</div>
      )}
    </div>
  )
}

export default function McpSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()
  const [overview, setOverview] = useState<McpHarnessOverview[] | null | undefined>(undefined)
  const [target, setTarget] = useState<McpAuthTarget | null>(null)
  const [generation, setGeneration] = useState(0)
  const changed = useCallback(() => setGeneration(n => n + 1), [])

  useEffect(() => {
    let live = true
    void fetchMcpOverview().then(o => { if (live) setOverview(o) })
    return () => { live = false }
  }, [])

  return (
    <div>
      <SectionHeader label={pt ? 'Servidores MCP' : 'MCP servers'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'Os servidores MCP que cada assistente tem, com o status que o próprio assistente informa. Quando um servidor pede autenticação, o botão abre o login do próprio assistente e mostra o link — sem terminal.'
          : 'The MCP servers each assistant has, with the status the assistant itself reports. When a server asks for authentication, the button starts the assistant’s own sign-in and shows its link — no terminal.'}
      </p>
      {overview === undefined ? (
        <CenteredLoader size={40} label={pt ? 'Verificando' : 'Checking'} testId="mcp-settings-loading" />
      ) : overview === null ? (
        <div role="alert" style={{ fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center', padding: '24px 0' }}>
          {pt ? 'Esta tela precisa de acesso à máquina local, e ele não está disponível aqui.' : 'This screen needs access to the local machine, and it is not available here.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {overview.map(h => (
            <HarnessMcpCard
              key={`${h.id}-${generation}`} h={h} pt={pt} isMobile={isMobile}
              onAuth={(harness, server) => setTarget({ harness: harness.id, harnessLabel: harness.label, server })}
            />
          ))}
        </div>
      )}
      <McpAuthDialog target={target} pt={pt} onClose={() => setTarget(null)} onChanged={changed} />
    </div>
  )
}
