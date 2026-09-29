import React, { useState } from 'react'
import { X, Monitor, Globe, Download, BarChart2, Share } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'

type PwaPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

interface Props {
  lang: string
  pwaPrompt: PwaPrompt | null
  onClose: (dontShowAgain: boolean) => void
  onPwaInstalled: () => void
}

const T = {
  title:        { en: 'Get the best experience',    pt: 'Tenha a melhor experiência' },
  sub:          { en: 'Install Agentistics for faster access and a native feel.', pt: 'Instale o Agentistics para acesso mais rápido e uma experiência nativa.' },
  webTitle:     { en: 'Web App',                    pt: 'App Web' },
  webDesc:      { en: 'Install from your browser. Instant, no download needed.', pt: 'Instale pelo navegador. Instantâneo, sem download.' },
  webTag:       { en: 'Recommended',                pt: 'Recomendado' },
  desktopTitle: { en: 'Desktop App',                pt: 'App Desktop' },
  desktopDesc:  { en: 'Windows installer with auto-updates.', pt: 'Instalador Windows com atualizações automáticas.' },
  notNow:       { en: 'Not now',                    pt: 'Agora não' },
  dontShow:     { en: "Don't show again",           pt: 'Não mostrar novamente' },
  installing:   { en: 'Installing…',                pt: 'Instalando…' },
  iosTitle:     { en: 'Add to Home Screen',         pt: 'Adicionar à Tela de Início' },
  iosStep1:     { en: 'Tap the Share button in the Safari bar.', pt: 'Toque no botão Compartilhar na barra do Safari.' },
  iosStep2:     { en: 'Choose “Add to Home Screen”.', pt: 'Escolha “Adicionar à Tela de Início”.' },
  iosStep3:     { en: 'Tap Add — it opens full-screen, like a native app.', pt: 'Toque em Adicionar — abre em tela cheia, como um app nativo.' },
}

function t(key: keyof typeof T, lang: string): string {
  return T[key][lang as 'en' | 'pt'] ?? T[key].en
}

export function InstallModal({ lang, pwaPrompt, onClose, onPwaInstalled }: Props) {
  const [dontShow, setDontShow] = useState(false)
  const [installing, setInstalling] = useState(false)
  const isMobile = useIsMobile()
  // iOS Safari has no install prompt — the only path is Share → Add to Home Screen.
  const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  async function handleWebApp() {
    if (!pwaPrompt) return
    setInstalling(true)
    try {
      await pwaPrompt.prompt()
      const { outcome } = await pwaPrompt.userChoice
      if (outcome === 'accepted') {
        onPwaInstalled()
        onClose(true)
        return
      }
    } catch {}
    setInstalling(false)
  }

  function handleDesktop() {
    window.open('https://github.com/agentistics/agentistics/releases/latest', '_blank', 'noopener')
    onClose(dontShow)
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(6px)',
        animation: 'fadeIn 0.2s ease-out',
      }}
      onClick={() => onClose(dontShow)}
    >
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
      `}</style>

      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          width: '100%', maxWidth: 480,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '24px 24px 0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: 'var(--anthropic-orange-dim)',
              border: '1px solid color-mix(in srgb, var(--anthropic-orange) 30%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <BarChart2 size={20} color="var(--anthropic-orange)" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 3 }}>
                {t('title', lang)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {t('sub', lang)}
              </div>
            </div>
          </div>
          <button
            onClick={() => onClose(dontShow)}
            style={{
              width: 28, height: 28, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 7,
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Options */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* iOS: no install prompt — show Add to Home Screen steps instead of the Web App button. */}
          {isIOS && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 14,
              padding: '14px 16px', borderRadius: 10,
              border: '1.5px solid var(--anthropic-orange)',
              background: 'var(--anthropic-orange-dim)',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Share size={16} color="var(--anthropic-orange)" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
                  {t('iosTitle', lang)}
                </div>
                <ol style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <li>{t('iosStep1', lang)}</li>
                  <li>{t('iosStep2', lang)}</li>
                  <li>{t('iosStep3', lang)}</li>
                </ol>
              </div>
            </div>
          )}

          {/* Web App card — hidden on iOS (no prompt). */}
          {!isIOS && (
          <button
            onClick={handleWebApp}
            disabled={!pwaPrompt || installing}
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 16px',
              borderRadius: 10,
              border: pwaPrompt ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
              background: pwaPrompt ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
              cursor: pwaPrompt ? 'pointer' : 'default',
              textAlign: 'left',
              fontFamily: 'inherit',
              opacity: pwaPrompt ? 1 : 0.5,
              transition: 'opacity 0.15s, border-color 0.15s',
              width: '100%',
            }}
          >
            <div style={{
              width: 36, height: 36, borderRadius: 9, flexShrink: 0,
              background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Globe size={16} color="var(--anthropic-orange)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {installing ? t('installing', lang) : t('webTitle', lang)}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: 'var(--anthropic-orange)',
                  background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--anthropic-orange) 25%, transparent)',
                  padding: '1px 6px', borderRadius: 4,
                }}>
                  {t('webTag', lang)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {pwaPrompt
                  ? t('webDesc', lang)
                  : window.location.port === '47292'
                    ? (lang === 'pt' ? 'Não disponível no servidor de dev — abra via porta 47291' : 'Not available in dev mode — open via port 47291')
                    : (lang === 'pt' ? 'Recarregue a página para habilitar' : 'Reload the page to enable')}
              </div>
            </div>
          </button>
          )}

          {/* Desktop App card — Windows only, hidden on phones. */}
          {!isMobile && (
          <button
            onClick={handleDesktop}
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 16px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg-elevated)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s, background 0.15s',
              width: '100%',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--text-tertiary)'
              e.currentTarget.style.background = 'var(--bg-card)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--border)'
              e.currentTarget.style.background = 'var(--bg-elevated)'
            }}
          >
            <div style={{
              width: 36, height: 36, borderRadius: 9, flexShrink: 0,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Monitor size={16} color="var(--text-secondary)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {t('desktopTitle', lang)}
                </span>
                <Download size={11} color="var(--text-tertiary)" />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {t('desktopDesc', lang)}
              </div>
            </div>
          </button>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '0 24px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: 'pointer', userSelect: 'none',
          }}>
            <input
              type="checkbox"
              checked={dontShow}
              onChange={e => setDontShow(e.target.checked)}
              style={{ accentColor: 'var(--anthropic-orange)', cursor: 'pointer', width: 14, height: 14 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {t('dontShow', lang)}
            </span>
          </label>

          <button
            onClick={() => onClose(dontShow)}
            style={{
              padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 500,
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = 'var(--text-primary)'
              e.currentTarget.style.borderColor = 'var(--text-tertiary)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'var(--text-secondary)'
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
          >
            {t('notNow', lang)}
          </button>
        </div>
      </div>
    </div>
  )
}
