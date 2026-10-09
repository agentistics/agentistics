import React, { useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Cpu, AlertCircle, CircleDot, ExternalLink } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { loginHarness, useChatHarnesses, type HarnessChatStatus } from '../../hooks/useChatHarnesses'
import { SectionHeader } from './primitives'
import { HarnessInstallDialog } from '../../components/HarnessInstallDialog'
import { sessionPath } from '../../lib/sessionRoute'
import { CenteredLoader } from '../../components/CenteredLoader'

export function HarnessStatusBadge({ h, pt = false }: { h: HarnessChatStatus; pt?: boolean }) {
  if (h.updateAvailable) {
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--anthropic-orange)', background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--anthropic-orange) 30%, transparent)', padding: '2px 8px', borderRadius: 20 }}>{pt ? 'Atualização disponível' : 'Update available'}</span>
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
      color: 'var(--anthropic-orange)',
      background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
      border: '1px solid color-mix(in srgb, var(--anthropic-orange) 30%, transparent)',
      padding: '2px 8px', borderRadius: 20,
    }}>
      <AlertCircle size={10} />
        {pt ? 'Precisa entrar na conta' : 'Needs sign-in'}
    </span>
  )
}

function HarnessCard({ h, pt }: { h: HarnessChatStatus; pt: boolean }) {
  const { setup } = h
  const hasGuidance = !h.ready && (setup.docUrl || setup.note)

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
          {/* Install / sign in are buttons now — people are never asked to type a command. */}
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
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [target, setTarget] = useState<HarnessChatStatus | null>(null)
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const signIn = async (h: HarnessChatStatus) => {
    setSigningIn(h.id); setNotice('')
    const out = await loginHarness(h.id, pt ? 'pt' : 'en')
    setSigningIn(null)
    if (out.ok && out.id) navigate(sessionPath(out.id))
    else setNotice(out.message || (pt ? 'Não consegui abrir o login agora. Tente de novo.' : 'Could not open the sign-in right now. Try again.'))
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
              {(!h.ready || h.updateAvailable === true) && <button type="button" disabled={signingIn === h.id} onClick={() => {
                if (h.installed && !h.authReady) { void signIn(h); return }
                setTarget(h)
              }} style={{ margin: '6px 0 8px 42px', minHeight: isMobile ? 44 : undefined, padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
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
      {notice && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>{notice}</div>}
      <HarnessInstallDialog target={target} pt={pt} onClose={() => setTarget(null)} onDone={() => reload()} />
    </div>
  )
}
