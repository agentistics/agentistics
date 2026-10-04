import React, { useState } from 'react'
import { Archive, AlertTriangle, ExternalLink, Check, FolderClock, ChevronDown, HardDrive, Globe } from 'lucide-react'

export type ArchiveMode = 'off' | 'consolidate' | 'full'

interface Props {
  lang: string
  onChoose: (mode: ArchiveMode) => void
  onLangChange?: (lang: 'pt' | 'en') => void
}

const DOCS_URL = 'https://code.claude.com/docs/en/settings'

const T = {
  badge:    { en: "Action required", pt: "Ação necessária" },
  title:    { en: "AI coding assistants prune session data automatically", pt: "Assistentes de IA apagam dados de sessão automaticamente" },
  body1:    {
    en: "Claude Code permanently deletes session transcripts older than 30 days on every startup (cleanupPeriodDays). Codex and other assistants also prune local history. Aggregate totals survive, but each old session's detail and agent metrics are lost forever.",
    pt: "O Claude Code apaga permanentemente os transcripts de sessões com mais de 30 dias a cada inicialização (cleanupPeriodDays). O Codex e outros assistentes também purgam o histórico local. Os totais agregados sobrevivem, mas o detalhe e as métricas de agentes de cada sessão antiga são perdidos para sempre.",
  },
  body2:    {
    en: "Agentistics can preserve your history locally in ~/.agentistics — across Claude Code, Codex, Gemini, and Copilot. The data never leaves your machine.",
    pt: "O Agentistics pode preservar seu histórico localmente em ~/.agentistics — para Claude Code, Codex, Gemini e Copilot. Os dados nunca saem da sua máquina.",
  },
  source:   { en: "Official documentation (Claude Code)", pt: "Documentação oficial (Claude Code)" },

  consTitle: { en: "Yes, preserve my history", pt: "Sim, preservar meu histórico" },
  consDesc:  { en: "Keeps every session's computed metrics forever (~KB). Nothing duplicated.", pt: "Mantém as métricas calculadas de cada sessão para sempre (~KB). Sem duplicar arquivos." },
  recommended: { en: "Recommended", pt: "Recomendado" },

  offTitle:  { en: "No, use each tool's default folders", pt: "Não, usar as pastas padrão de cada ferramenta" },
  offDesc:   { en: "Sessions older than the cleanup threshold will keep disappearing.", pt: "Sessões acima do limite de limpeza vão continuar sumindo." },

  advToggle: { en: 'Advanced — keep full copy of everything', pt: 'Avançado — guardar cópia completa de tudo' },
  fullTitle: { en: 'Keep full transcripts too', pt: 'Guardar transcripts completos também' },
  fullDesc:  { en: 'Mirror raw conversations so you can re-read them. Uses much more disk and grows over time.', pt: 'Espelha as conversas cruas para você poder relê-las. Usa muito mais disco e cresce com o tempo.' },

  mustChoose:  { en: 'Choose an option to continue. You can change this later in Settings.', pt: 'Escolha uma opção para continuar. Você pode mudar isso depois em Configurações.' },
}

function t(key: keyof typeof T, lang: string): string {
  return T[key][lang as 'en' | 'pt'] ?? T[key].en
}

export function ArchiveConsentModal({ lang, onChoose, onLangChange }: Props) {
  const [submitting, setSubmitting] = useState<ArchiveMode | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const choose = (mode: ArchiveMode) => {
    if (submitting !== null) return
    setSubmitting(mode)
    onChoose(mode)
  }

  const dim = (mode: ArchiveMode) => (submitting !== null && submitting !== mode ? 0.5 : 1)

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(0,0,0,0.78)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 560,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-elevated)',
          padding: 28,
          maxHeight: 'calc(90vh / var(--ag-zoom, 1))',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--anthropic-orange)',
              background: 'var(--anthropic-orange-dim)',
              padding: '4px 10px',
              borderRadius: 20,
            }}
          >
            <AlertTriangle size={13} />
            {t('badge', lang)}
          </span>

          {/* Language toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              border: '1px solid var(--border)',
              borderRadius: 20,
              padding: '3px 4px 3px 8px',
            }}
          >
            <Globe size={13} style={{ color: 'var(--text-tertiary)' }} />
            {(['en', 'pt'] as const).map(l => {
              const active = (lang === 'pt' ? 'pt' : 'en') === l
              return (
                <button
                  key={l}
                  onClick={() => onLangChange?.(l)}
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 14,
                    border: 'none',
                    cursor: active ? 'default' : 'pointer',
                    background: active ? 'var(--anthropic-orange)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-tertiary)',
                    fontFamily: 'inherit',
                  }}
                >
                  {l === 'pt' ? 'PT' : 'EN'}
                </button>
              )
            })}
          </div>
        </div>

        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 14px', lineHeight: 1.25 }}>
          {t('title', lang)}
        </h2>

        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px' }}>
          {t('body1', lang)}
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 16px' }}>
          {t('body2', lang)}
        </p>

        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: 'var(--anthropic-orange)',
            textDecoration: 'none',
            marginBottom: 22,
          }}
        >
          <ExternalLink size={14} />
          {t('source', lang)} — code.claude.com/docs
        </a>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Primary: consolidate (recommended) */}
          <button
            onClick={() => choose('consolidate')}
            disabled={submitting !== null}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              textAlign: 'left',
              padding: '16px 18px',
              borderRadius: 'var(--radius-lg)',
              border: '1.5px solid var(--anthropic-orange)',
              background: 'var(--anthropic-orange-dim)',
              cursor: submitting !== null ? 'default' : 'pointer',
              opacity: dim('consolidate'),
            }}
          >
            <Archive size={20} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{t('consTitle', lang)}</span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: 'var(--accent-green)',
                    border: '1px solid var(--accent-green)',
                    padding: '1px 6px',
                    borderRadius: 10,
                  }}
                >
                  {t('recommended', lang)}
                </span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{t('consDesc', lang)}</div>
            </div>
            {submitting === 'consolidate' && <Check size={18} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />}
          </button>

          {/* Primary: off */}
          <button
            onClick={() => choose('off')}
            disabled={submitting !== null}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              textAlign: 'left',
              padding: '16px 18px',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              cursor: submitting !== null ? 'default' : 'pointer',
              opacity: dim('off'),
            }}
          >
            <FolderClock size={20} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('offTitle', lang)}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{t('offDesc', lang)}</div>
            </div>
            {submitting === 'off' && <Check size={18} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
          </button>
        </div>

        {/* Advanced: full copy — made prominent so it's clearly discoverable */}
        <button
          onClick={() => setShowAdvanced(v => !v)}
          disabled={submitting !== null}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            justifyContent: 'center',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--text-secondary)',
            fontSize: 13,
            fontWeight: 600,
            cursor: submitting !== null ? 'default' : 'pointer',
            padding: '11px 14px',
            marginTop: 12,
            fontFamily: 'inherit',
          }}
        >
          <ChevronDown size={15} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
          {t('advToggle', lang)}
        </button>

        {showAdvanced && (
          <button
            onClick={() => choose('full')}
            disabled={submitting !== null}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              textAlign: 'left',
              width: '100%',
              padding: '14px 16px',
              marginTop: 8,
              borderRadius: 'var(--radius-lg)',
              border: '1px dashed var(--border)',
              background: 'var(--bg-card)',
              cursor: submitting !== null ? 'default' : 'pointer',
              opacity: dim('full'),
            }}
          >
            <HardDrive size={18} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('fullTitle', lang)}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3 }}>{t('fullDesc', lang)}</div>
            </div>
            {submitting === 'full' && <Check size={18} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />}
          </button>
        )}

        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center', margin: '18px 0 0' }}>
          {t('mustChoose', lang)}
        </p>
      </div>
    </div>
  )
}
