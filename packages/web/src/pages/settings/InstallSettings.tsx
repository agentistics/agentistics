import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Globe, Monitor, Download } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { DeployCentral } from '../../components/DeployCentral'

export default function InstallSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const { pwaPrompt, onPwaInstalled, isCentral } = ctx

  // iOS Safari has no beforeinstallprompt — install is always Share → "Add to Home Screen".
  const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true
  const isDevPort = window.location.port === '47292'
  const [uninstallHint, setUninstallHint] = useState(false)

  const pwaStatus = pwaPrompt
    ? 'available'
    : isStandalone ? 'installed' : isIOS ? 'ios' : isDevPort ? 'dev' : 'waiting'

  const pwaHint: Record<string, string> = {
    available: pt ? 'Instale pelo navegador, sem download necessário.' : 'Install via browser — no download needed.',
    installed:  pt ? 'Você já está usando o App Web instalado.' : 'You are already using the installed Web App.',
    dev:        pt ? 'Não disponível no servidor de dev. Abra via porta 47291.' : 'Not available in dev mode. Open via port 47291.',
    waiting:    pt ? 'Recarregue a página para habilitar a instalação.' : 'Reload the page to enable installation.',
    ios:        pt ? 'No iPhone/iPad: toque em Compartilhar e em “Adicionar à Tela de Início”.' : 'On iPhone/iPad: tap Share, then “Add to Home Screen”.',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Web App card */}
      <div style={{
        padding: '16px 18px', borderRadius: 10,
        border: pwaPrompt ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
        background: pwaPrompt ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9, flexShrink: 0, marginTop: 1,
              background: pwaPrompt ? 'color-mix(in srgb, var(--anthropic-orange) 15%, transparent)' : 'var(--bg-card)',
              border: `1px solid ${pwaPrompt ? 'color-mix(in srgb, var(--anthropic-orange) 30%, transparent)' : 'var(--border)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Globe size={16} color={pwaPrompt ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {pt ? 'App Web (PWA)' : 'Web App (PWA)'}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: 'var(--anthropic-orange)',
                  background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--anthropic-orange) 25%, transparent)',
                  padding: '1px 6px', borderRadius: 4,
                }}>
                  {pt ? 'Recomendado' : 'Recommended'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {pwaHint[pwaStatus]}
              </div>
            </div>
          </div>
          {pwaStatus === 'ios' ? null : pwaStatus === 'installed' ? (
            <button
              onClick={() => setUninstallHint(h => !h)}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, flexShrink: 0,
                border: '1px solid rgba(239,68,68,0.4)',
                background: uninstallHint ? 'rgba(239,68,68,0.12)' : 'transparent',
                color: '#ef4444', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
              }}
            >
              {pt ? 'Desinstalar' : 'Uninstall'}
            </button>
          ) : (
            <button
              onClick={async () => {
                if (!pwaPrompt) return
                try {
                  await pwaPrompt.prompt()
                  const { outcome } = await pwaPrompt.userChoice
                  if (outcome === 'accepted') onPwaInstalled()
                } catch {}
              }}
              disabled={!pwaPrompt}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, flexShrink: 0,
                border: pwaPrompt ? '1px solid var(--anthropic-orange)' : '1px solid var(--border)',
                background: pwaPrompt ? 'color-mix(in srgb, var(--anthropic-orange) 20%, transparent)' : 'transparent',
                color: pwaPrompt ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                cursor: pwaPrompt ? 'pointer' : 'default',
                fontFamily: 'inherit', opacity: pwaPrompt ? 1 : 0.5,
              }}
            >
              {pt ? 'Instalar' : 'Install'}
            </button>
          )}
        </div>
        {uninstallHint && (
          <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 7,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
            fontSize: 12, color: '#ef4444', lineHeight: 1.5,
          }}>
            {pt
              ? 'Para desinstalar: clique no menu ⋮ no canto superior direito da janela do app → "Desinstalar Agentistics".'
              : 'To uninstall: click the ⋮ menu in the top-right corner of the app window → "Uninstall Agentistics".'}
          </div>
        )}
        {pwaStatus === 'ios' && (
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 8,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              {pt ? 'Instalar no iPhone / iPad' : 'Install on iPhone / iPad'}
            </div>
            {pt ? (
              <>1. Toque no botão <strong>Compartilhar</strong> (o quadrado com a seta) na barra do Safari.<br />
              2. Role e toque em <strong>“Adicionar à Tela de Início”</strong>.<br />
              3. Toque em <strong>Adicionar</strong>. O app abre em tela cheia, como um app nativo.</>
            ) : (
              <>1. Tap the <strong>Share</strong> button (square with an arrow) in the Safari bar.<br />
              2. Scroll and tap <strong>“Add to Home Screen”</strong>.<br />
              3. Tap <strong>Add</strong>. The app opens full-screen, like a native app.</>
            )}
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
              {pt
                ? 'O iOS não permite instalação com um clique — esse é o fluxo oficial da Apple.'
                : 'iOS does not allow one-click install — this is Apple’s official flow.'}
            </div>
          </div>
        )}
      </div>

      {/* Desktop App card */}
      <div style={{
        padding: '16px 18px', borderRadius: 10,
        border: '1px solid var(--border)', background: 'var(--bg-elevated)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9, flexShrink: 0, marginTop: 1,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Monitor size={16} color="var(--text-secondary)" />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
                {pt ? 'App Desktop (Windows)' : 'Desktop App (Windows)'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {pt ? 'Instalador NSIS com atualizações automáticas via Tauri.' : 'NSIS installer with auto-updates via Tauri.'}
              </div>
            </div>
          </div>
          <button
            onClick={() => window.open('https://github.com/agentistics/agentistics/releases/latest', '_blank', 'noopener')}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, flexShrink: 0,
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', cursor: 'pointer',
              fontFamily: 'inherit', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--text-tertiary)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--border)' }}
          >
            <Download size={12} />{pt ? 'Baixar' : 'Download'}
          </button>
        </div>
      </div>

      {/* Info footer */}
      <div style={{
        padding: '12px 14px', borderRadius: 8,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6,
      }}>
        💡 {pt
          ? 'O App Web é mais rápido de instalar e funciona em qualquer plataforma. O App Desktop oferece integração nativa no Windows com ícone na barra de tarefas.'
          : 'The Web App is faster to install and works on any platform. The Desktop App offers native Windows integration with a taskbar icon.'}
      </div>

      {!isCentral && (
        <>
          {/* Deploy a team central — only shown on non-central instances */}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 4px' }} />
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)',
            letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10,
          }}>
            {pt ? 'Para equipes' : 'For teams'}
          </div>
          <DeployCentral pt={pt} />
        </>
      )}
    </div>
  )
}
