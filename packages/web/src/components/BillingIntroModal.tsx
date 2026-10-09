import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Receipt, X } from 'lucide-react'
import type { BillingGap, HarnessId, Lang } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'

/**
 * The billing setup prompt — ONE component serving both entrances.
 *
 *   'intro' — the first-run invite. Non-blocking, and it repeats each load until dismissed for
 *             good. It is mounted AFTER the archive consent gate: two modals on a first launch,
 *             one blocking and one not, is a stack nobody reads.
 *   'setup' — what the DISABLED cost-basis control opens. Same screen, but it lists exactly what
 *             is missing, because a prompt that re-asks for what the app already detected is one
 *             people abandon halfway.
 *
 * Neither writes anything. Both hand off to Settings → Billing, which is the only place a period
 * is created — there is no second, quicker path that skips the validation the real form applies.
 */
export function BillingIntroModal({ open, mode, gaps, lang, onClose, onNeverShowAgain }: {
  open: boolean
  mode: 'intro' | 'setup'
  /** What is still missing. Empty in `intro` mode, where nothing has been attempted yet. */
  gaps: BillingGap[]
  lang: Lang
  onClose: () => void
  /** Only offered in `intro` mode — "don't show again" for a prompt the user opened themselves
   *  would be a switch that turns off the thing they just asked for. */
  onNeverShowAgain?: () => void
}) {
  const navigate = useNavigate()
  const pt = lang === 'pt'
  if (!open) return null

  const go = () => { onClose(); navigate('/settings/billing') }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: '100%', maxWidth: 460, background: 'var(--bg-card)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
          padding: '20px 20px 16px', position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label={pt ? 'Fechar' : 'Close'}
          style={{
            position: 'absolute', top: 10, right: 10, background: 'none', border: 'none',
            color: 'var(--text-tertiary)', cursor: 'pointer', padding: 6, lineHeight: 0,
          }}
        >
          <X size={16} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
          <Receipt size={18} style={{ color: 'var(--anthropic-orange)' }} />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            {mode === 'setup'
              ? (pt ? 'Falta cadastrar seu plano' : 'Your plan is not registered yet')
              : (pt ? 'Como você paga pelo seu assistente?' : 'How do you pay for your assistant?')}
          </h2>
        </div>

        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px' }}>
          {pt
            ? 'Todo custo aqui é uma estimativa a preços de API. Se você paga uma assinatura, esse número não é a sua fatura — cadastre o que você realmente paga e o app passa a mostrar o custo do seu plano, e quanto de valor você extraiu dele.'
            : 'Every cost here is an API-price estimate. If you pay a subscription, that figure is not your invoice — register what you actually pay and the app can show your plan cost instead, and how much value you got out of it.'}
        </p>

        {gaps.length > 0 && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            padding: '10px 12px', marginBottom: 12, background: 'var(--bg-hover)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 }}>
              {pt ? 'O que falta' : 'What is missing'}
            </div>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {gaps.slice(0, 4).map((gap, i) => <li key={i}>{describeGap(gap, pt)}</li>)}
            </ul>
          </div>
        )}

        <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
          {pt
            ? 'Tudo fica nesta máquina. Nada disso sai dela.'
            : 'It all stays on this machine. None of it leaves it.'}
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={go}
            style={{
              flex: '1 1 160px', minHeight: 40, padding: '10px 14px', borderRadius: 'var(--radius-md)',
              border: 'none', background: 'var(--anthropic-orange)', color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {pt ? 'Cadastrar agora' : 'Register now'}
          </button>
          {mode === 'intro' && onNeverShowAgain && (
            <button
              onClick={onNeverShowAgain}
              style={{
                flex: '1 1 160px', minHeight: 40, padding: '10px 14px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-tertiary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {pt ? 'Não mostrar de novo' : 'Don’t show again'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const harnessName = (h: HarnessId): string => HARNESS_LABELS[h] ?? h

/** One sentence per gap, naming the harness — a fleet of six harnesses makes "a plan is missing"
 *  useless on its own. */
function describeGap(gap: BillingGap, pt: boolean): string {
  switch (gap.code) {
    case 'no_timeline':
      return pt
        ? `${harnessName(gap.harness)}: nenhum período cadastrado.`
        : `${harnessName(gap.harness)}: no period registered.`
    case 'invalid_timeline':
      return pt
        ? `${harnessName(gap.harness)}: há períodos que se sobrepõem — dois planos não podem cobrir o mesmo dia.`
        : `${harnessName(gap.harness)}: periods overlap — two plans cannot cover the same day.`
    case 'incomplete_period': {
      const name = gap.label ?? gap.planId ?? (pt ? 'um período' : 'a period')
      const needsPrice = gap.errors.some(e => e.code === 'missing_price' || e.code === 'non_positive_price')
      if (needsPrice) {
        return pt
          ? `${harnessName(gap.harness)}: falta o valor mensal de "${name}".`
          : `${harnessName(gap.harness)}: “${name}” has no monthly amount.`
      }
      return pt
        ? `${harnessName(gap.harness)}: "${name}" está incompleto.`
        : `${harnessName(gap.harness)}: “${name}” is incomplete.`
    }
  }
}
