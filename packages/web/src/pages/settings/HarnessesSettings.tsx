import React, { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Cpu, Copy, CheckCheck, AlertCircle, CircleDot, ExternalLink } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { installHarness, useChatHarnesses, type HarnessChatStatus } from '../../hooks/useChatHarnesses'
import { ConfirmModal, SectionHeader } from './primitives'
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

export function HarnessStatusBadge({ h, pt = false }: { h: HarnessChatStatus; pt?: boolean }) {
  if (h.updateAvailable) {
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.10)', border: '1px solid rgba(249,115,22,0.28)', padding: '2px 8px', borderRadius: 20 }}>{pt ? 'Atualização disponível' : 'Update available'}</span>
  }
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
        {h.version ? `${pt ? 'Instalado' : 'Installed'} · v${h.version}` : (pt ? 'Instalado' : 'Installed')}
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
        {pt ? 'Não instalado' : 'Not installed'}
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
        {pt ? 'Precisa entrar na conta' : 'Needs sign-in'}
    </span>
  )
}

function HarnessCard({ h, pt }: { h: HarnessChatStatus; pt: boolean }) {
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
            <HarnessStatusBadge h={h} pt={pt} />
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
  const { harnesses, loading, reload } = useChatHarnesses()
  const [target, setTarget] = useState<HarnessChatStatus | null>(null)
  const [progress, setProgress] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const begin = async () => {
    if (!target) return
    setRunning(true); setProgress([])
    const result = await installHarness(target.id, target.installed, line => setProgress(p => [...p, line]))
    if (!result.ok) setProgress(p => [...p, result.error ?? (pt ? 'Falha na instalação.' : 'Installation failed.')])
    setRunning(false); if (result.ok) { setTarget(null); reload() }
  }
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
            {harnesses.map(h => <div key={h.id}>
              <HarnessCard h={h} pt={pt} />
              {(!h.ready || h.updateAvailable === true) && <button type="button" onClick={() => {
                if (h.installed && !h.authReady) { window.location.assign('/sessions'); return }
                setTarget(h)
              }} style={{ margin: '6px 0 8px 42px', padding: '7px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
                {h.installed && !h.authReady ? (pt ? 'Entrar' : 'Sign in') : h.installed ? (pt ? 'Atualizar' : 'Update') : (pt ? 'Instalar' : 'Install')}
              </button>}
            </div>)}
          </div>
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 8,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6,
          }}>
            {pt
              ? `${readyCount} de ${harnesses.length} backends prontos. Instale e entre na conta pelos botões acima.`
              : `${readyCount} of ${harnesses.length} backends ready. Install and sign in with the buttons above.`}
          </div>
        </>
      )}
      <ConfirmModal
        open={target !== null}
        title={target ? `${pt ? 'Instalar' : 'Install'} ${target.label}?` : ''}
        message={target ? (pt ? `Vamos instalar ${target.label}, pelo instalador oficial, como seu usuário. Nenhum sudo será usado.` : `We will install ${target.label} from its official installer, as your user. sudo will not be used.`) : ''}
        confirmLabel={running ? (pt ? 'Instalando…' : 'Installing…') : (pt ? 'Continuar' : 'Continue')}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onCancel={() => { if (!running) setTarget(null) }}
        onConfirm={() => { void begin() }}
      >
        {progress.length > 0 && <div aria-live="polite" style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-elevated)', padding: 8, borderRadius: 7 }}>{progress.map((p, i) => <div key={`${p}-${i}`}>{p}</div>)}</div>}
      </ConfirmModal>
    </div>
  )
}
