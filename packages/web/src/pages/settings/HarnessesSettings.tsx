import React, { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Cpu, Copy, CheckCheck, AlertCircle, CircleDot, ExternalLink } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useChatHarnesses, type HarnessChatStatus } from '../../hooks/useChatHarnesses'
import { SectionHeader } from './primitives'
import { CenteredLoader } from '../../components/CenteredLoader'

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '5px 10px', marginTop: 5,
    }}>
      <code style={{ flex: 1, fontSize: 11.5, color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
        {text}
      </code>
      <button
        onClick={copy}
        title="Copy"
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: copied ? 'var(--accent-green)' : 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center', padding: 2, flexShrink: 0,
          transition: 'color 0.15s',
        }}
      >
        {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

function HarnessStatusBadge({ h }: { h: HarnessChatStatus }) {
  if (h.ready) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, fontWeight: 700,
        color: 'var(--accent-green)',
        background: 'color-mix(in srgb, var(--accent-green) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent-green) 28%, transparent)',
        padding: '2px 8px', borderRadius: 20,
      }}>
        <CircleDot size={10} />
        Ready
      </span>
    )
  }
  if (!h.installed) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, fontWeight: 700,
        color: 'var(--text-tertiary)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        padding: '2px 8px', borderRadius: 20,
      }}>
        <AlertCircle size={10} />
        Not installed
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 700,
      color: '#f97316',
      background: 'rgba(249,115,22,0.10)',
      border: '1px solid rgba(249,115,22,0.28)',
      padding: '2px 8px', borderRadius: 20,
    }}>
      <AlertCircle size={10} />
      Not authenticated
    </span>
  )
}

function HarnessCard({ h }: { h: HarnessChatStatus }) {
  const { setup } = h
  const hasGuidance = !h.ready && (setup.installCmd || setup.loginCmd || setup.docUrl || setup.note)

  return (
    <div style={{
      padding: '14px 16px', borderRadius: 10,
      border: h.ready
        ? '1px solid color-mix(in srgb, var(--accent-green) 25%, var(--border))'
        : '1px solid var(--border)',
      background: h.ready ? 'color-mix(in srgb, var(--accent-green) 5%, var(--bg-elevated))' : 'var(--bg-elevated)',
      display: 'flex', flexDirection: 'column', gap: 0,
    }}>
      {/* Row: icon + name + badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: hasGuidance ? 10 : 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Cpu size={14} color={h.ready ? 'var(--accent-green)' : 'var(--text-tertiary)'} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{h.label}</span>
            <HarnessStatusBadge h={h} />
          </div>
          {h.ready && h.models.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {h.models.length} model{h.models.length !== 1 ? 's' : ''} available
              {h.defaultModel ? ` · default: ${h.defaultModel}` : ''}
            </div>
          )}
        </div>
      </div>

      {/* Setup guidance for non-ready harnesses */}
      {hasGuidance && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 42 }}>
          {!h.installed && setup.installCmd && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 1 }}>Install</div>
              <CopyableCode text={setup.installCmd} />
            </div>
          )}
          {h.installed && !h.authReady && setup.loginCmd && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 1 }}>Authenticate</div>
              <CopyableCode text={setup.loginCmd} />
            </div>
          )}
          {/* Show login cmd even when not installed, as reference */}
          {!h.installed && setup.loginCmd && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 1 }}>Then login</div>
              <CopyableCode text={setup.loginCmd} />
            </div>
          )}
          {setup.note && (
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5,
              padding: '5px 8px', borderRadius: 6,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              marginTop: 2,
            }}>
              {setup.note}
            </div>
          )}
          {setup.docUrl && (
            <a
              href={setup.docUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11.5, color: 'var(--anthropic-orange)', textDecoration: 'none',
                marginTop: 2,
              }}
            >
              <ExternalLink size={11} />
              Learn more / check eligibility
            </a>
          )}
        </div>
      )}
    </div>
  )
}

export default function HarnessesSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const { harnesses, loading } = useChatHarnesses()
  const readyCount = harnesses.filter(h => h.ready).length

  return (
    <div>
      <SectionHeader label={pt ? 'Backends de IA (Nay chat)' : 'AI backends (Nay chat)'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'Cada backend pode ser usado para conversar via Nay. Mostramos o status de instalação e autenticação de cada um.'
          : 'Each backend can be used for chat in Nay. Showing installation and authentication status for all known harnesses.'}
      </p>

      {loading ? (
        <CenteredLoader size={40} label={pt ? 'Verificando' : 'Checking'} testId="harnesses-loading" />
      ) : harnesses.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center', padding: '24px 0' }}>
          {pt ? 'Nenhum backend encontrado.' : 'No backends found.'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {harnesses.map(h => <HarnessCard key={h.id} h={h} />)}
          </div>
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 8,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6,
          }}>
            {pt
              ? `${readyCount} de ${harnesses.length} backends prontos. Instalação e autenticação devem ser feitas no terminal — o Agentistics não executa comandos automaticamente.`
              : `${readyCount} of ${harnesses.length} backend${harnesses.length !== 1 ? 's' : ''} ready. Install and authenticate in your terminal — Agentistics does not run commands on your behalf.`}
          </div>
        </>
      )}
    </div>
  )
}
