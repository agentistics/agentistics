import React, { useRef, useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { GripVertical, RotateCcw, Save } from 'lucide-react'
import type { Lang, Theme } from '@agentistics/core'
import type { AppContext, PrefsDraft } from '../../lib/app-context'
import { SectionHeader, Divider, TabSelect, PrefRow, Toggle, Checkbox } from './primitives'
import { DEFAULT_CARD_ORDER, type CardId } from '../../lib/cardOrder'

/** One label per `CardId`. Typed as the Record so the build fails if a card is added and this is
 *  not — the same reason `HARNESS_CAPABILITIES` is a Record rather than a list. */
const CARD_LABELS: Record<CardId, { en: string; pt: string }> = {
  messages:         { en: 'Messages',        pt: 'Mensagens' },
  sessions:         { en: 'Sessions',        pt: 'Sessões' },
  'tool-calls':     { en: 'Tool calls',      pt: 'Tool calls' },
  tokens:           { en: 'Tokens',          pt: 'Tokens' },
  cost:             { en: 'Est. cost',       pt: 'Custo estimado' },
  streak:           { en: 'Streak',          pt: 'Sequência' },
  'longest-session':{ en: 'Longest session', pt: 'Sessão mais longa' },
  commits:          { en: 'Commits',         pt: 'Commits' },
  files:            { en: 'Files',           pt: 'Arquivos' },
}

// The order lived here as a SECOND copy and had to be edited in lockstep with App.tsx's — the
// duplication CLAUDE.md forbids for harness lists, for the same reason: an array literal with a
// member missing still compiles.
const METRIC_IDS = ['kpi.messages', 'kpi.sessions', 'kpi.tool-calls', 'kpi.tokens']

function seedDraft(ctx: AppContext): PrefsDraft {
  return {
    lang: ctx.lang,
    theme: ctx.theme,
    currency: ctx.currency,
    cardOrder: [...ctx.cardOrder],
    cardPrecision: { ...ctx.cardPrecision },
  }
}

export default function PreferencesSettings() {
  const ctx = useOutletContext<AppContext>()
  const [scanRootsText, setScanRootsText] = useState('')
  const [scanRootsSaving, setScanRootsSaving] = useState(false)
  const [scanRootsMessage, setScanRootsMessage] = useState('')
  useEffect(() => {
    if (ctx.isCentral) return
    void fetch('/api/preferences')
      .then(r => r.ok ? r.json() as Promise<{ scanRoots?: string[] }> : null)
      .then(p => {
        const roots = Array.isArray(p?.scanRoots) ? p!.scanRoots.filter(x => typeof x === 'string') : []
        setScanRootsText(roots.join('\n'))
      })
      .catch(() => {})
  }, [ctx.isCentral])
  // Central-wide delete policy. Owner-only AND central-only: it is not a personal preference —
  // turning it off removes a safety net for everyone on this central. null until read, so the row
  // never flashes a wrong state.
  const isOwnerOnCentral = ctx.isCentral && ctx.me?.role === 'owner'
  const [requireDeleteText, setRequireDeleteText] = useState<boolean | null>(null)
  const [savingDeleteText, setSavingDeleteText] = useState(false)
  const [includeDeleted, setIncludeDeleted] = useState<boolean | null>(null)
  const [savingIncludeDeleted, setSavingIncludeDeleted] = useState(false)
  const [telemetryEnabled, setTelemetryEnabled] = useState(true)
  const [savingTelemetry, setSavingTelemetry] = useState(false)
  useEffect(() => { void fetch('/api/preferences').then(r => r.ok ? r.json() : null).then(p => { if (p) setTelemetryEnabled(p.telemetryEnabled !== false) }).catch(() => {}) }, [])
  async function toggleTelemetry(value: boolean) {
    setSavingTelemetry(true); setTelemetryEnabled(value)
    try { const r = await fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telemetryEnabled: value, telemetryNoticeDismissed: true }) }); if (!r.ok) throw new Error() } catch { setTelemetryEnabled(!value) } finally { setSavingTelemetry(false) }
  }
  useEffect(() => {
    if (!isOwnerOnCentral) return
    void fetch('/api/team/config')
      .then(r => r.ok ? r.json() as Promise<{ requireDeleteConfirmText?: boolean; includeDeletedMembers?: boolean }> : null)
      .then(c => {
        if (!c) return
        setRequireDeleteText(c.requireDeleteConfirmText ?? true)
        setIncludeDeleted(c.includeDeletedMembers ?? false)
      })
      .catch(() => { /* leave null → row hidden */ })
  }, [isOwnerOnCentral])
  async function toggleIncludeDeleted() {
    const next = !includeDeleted
    setSavingIncludeDeleted(true)
    setIncludeDeleted(next)
    try {
      const res = await fetch('/api/team/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeDeletedMembers: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const c = await res.json() as { includeDeletedMembers?: boolean }
      setIncludeDeleted(c.includeDeletedMembers ?? next)
    } catch {
      setIncludeDeleted(!next)
    } finally {
      setSavingIncludeDeleted(false)
    }
  }

  async function toggleRequireDeleteText() {
    const next = !requireDeleteText
    setSavingDeleteText(true)
    setRequireDeleteText(next) // optimistic
    try {
      const res = await fetch('/api/team/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireDeleteConfirmText: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const c = await res.json() as { requireDeleteConfirmText?: boolean }
      setRequireDeleteText(c.requireDeleteConfirmText ?? next)
    } catch {
      setRequireDeleteText(!next) // revert (the server 403s anyone but an owner)
    } finally {
      setSavingDeleteText(false)
    }
  }
  const [draft, setDraft] = useState<PrefsDraft>(() => seedDraft(ctx))
  const pt = draft.lang === 'pt'

  function set<K extends keyof PrefsDraft>(k: K, v: PrefsDraft[K]) {
    setDraft(d => ({ ...d, [k]: v }))
  }

  const dragRef = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  function handleDragStart(id: string) { dragRef.current = id }
  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault()
    if (dragRef.current !== id) setDragOver(id)
  }
  function handleDrop(id: string) {
    const from = dragRef.current
    if (!from || from === id) { dragRef.current = null; setDragOver(null); return }
    const next = [...draft.cardOrder]
    const fi = next.indexOf(from); const ti = next.indexOf(id)
    next.splice(fi, 1); next.splice(ti, 0, from)
    set('cardOrder', next)
    dragRef.current = null; setDragOver(null)
  }
  function handleDragEnd() { dragRef.current = null; setDragOver(null) }

  const allFull = METRIC_IDS.every(id => draft.cardPrecision[id] === true)
  const numFormat = allFull ? 'full' : 'abbr'
  function setAllNumbers(full: boolean) {
    const next = { ...draft.cardPrecision }
    for (const id of METRIC_IDS) next[id] = full
    set('cardPrecision', next)
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(seedDraft(ctx))
  async function saveScanRoots() {
    const roots = [...new Set(scanRootsText.split(/\r?\n/).map(x => x.trim()).filter(Boolean))]
    setScanRootsSaving(true)
    setScanRootsMessage('')
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanRoots: roots }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setScanRootsText(roots.join('\n'))
      setScanRootsMessage(pt ? 'Salvo.' : 'Saved.')
    } catch {
      setScanRootsMessage(pt ? 'Não foi possível salvar.' : 'Could not save.')
    } finally {
      setScanRootsSaving(false)
    }
  }

  return (
    <>
      {/* Central policy — owner only. Sits in Preferences because that is where a person looks for
          a switch, but it is central-wide state, not a per-user setting. */}
      {isOwnerOnCentral && requireDeleteText !== null && (
        <>
          <SectionHeader label={pt ? 'Segurança' : 'Safety'} />
          <div style={{ marginBottom: 16 }}>
            <PrefRow
              label={pt ? 'Confirmar exclusões digitando o nome' : 'Confirm deletions by typing the name'}
              sub={pt
                ? 'Exige digitar o nome exato antes de excluir. Vale para toda a central.'
                : 'Requires typing the exact name before deleting. Applies to the whole central.'}
            >
              <span style={{ opacity: savingDeleteText ? 0.6 : 1 }}>
                <Toggle on={requireDeleteText} onToggle={() => { void toggleRequireDeleteText() }} />
              </span>
            </PrefRow>
            {includeDeleted !== null && (
              <PrefRow
                label={pt ? 'Incluir métricas de contas e máquinas excluídas' : 'Include metrics from deleted accounts and machines'}
                sub={pt
                  ? 'Mantém o histórico de quem foi removido, para rastreio completo. Desligado, uma exclusão para de contar.'
                  : 'Keeps the history of anyone removed, for full traceability. Off, a deletion stops counting.'}
              >
                <span style={{ opacity: savingIncludeDeleted ? 0.6 : 1 }}>
                  <Toggle on={includeDeleted} onToggle={() => { void toggleIncludeDeleted() }} />
                </span>
              </PrefRow>
            )}
          </div>
          <Divider />
        </>
      )}

      {/*  Display  */}
      <SectionHeader label={pt ? 'Privacidade' : 'Privacy'} />
      <PrefRow
        label={pt ? 'Enviar um sinal anônimo de uso' : 'Send an anonymous usage signal'}
        sub={pt ? 'Enviar um número aleatório, a versão e o sistema uma vez por dia, para sabermos quantas pessoas usam o Agentistics. Nada do seu trabalho é enviado.' : 'Send a random number, the version, and the system once a day, so we can know how many people use Agentistics. None of your work is sent.'}
      >
        <span style={{ opacity: savingTelemetry ? 0.6 : 1 }}><Checkbox checked={telemetryEnabled} onChange={toggleTelemetry} label={pt ? 'Enviar sinal anônimo' : 'Send anonymous signal'} disabled={savingTelemetry} /></span>
      </PrefRow>
      <Divider />
      <SectionHeader label={pt ? 'Exibição' : 'Display'} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, marginBottom: 5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{pt ? 'Tema' : 'Theme'}</div>
            <TabSelect
              options={[{ value: 'dark' as Theme, label: pt ? 'Escuro' : 'Dark' }, { value: 'light' as Theme, label: pt ? 'Claro' : 'Light' }]}
              value={draft.theme}
              onChange={v => set('theme', v)}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, marginBottom: 5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{pt ? 'Idioma' : 'Language'}</div>
            <TabSelect
              options={[{ value: 'en' as Lang, label: 'English' }, { value: 'pt' as Lang, label: 'Português' }]}
              value={draft.lang}
              onChange={v => set('lang', v)}
            />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, marginBottom: 5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{pt ? 'Moeda' : 'Currency'}</div>
            <TabSelect
              options={[{ value: 'USD' as 'USD'|'BRL', label: 'USD $' }, { value: 'BRL' as 'USD'|'BRL', label: 'BRL R$' }]}
              value={draft.currency}
              onChange={v => set('currency', v)}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, marginBottom: 5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{pt ? 'Números' : 'Numbers'}</div>
            <TabSelect
              options={[{ value: 'abbr', label: '1.2M' }, { value: 'full', label: '1,234,567' }]}
              value={numFormat}
              onChange={v => setAllNumbers(v === 'full')}
            />
          </div>
        </div>
      </div>

      <Divider />

      {!ctx.isCentral && (
        <>
          <SectionHeader label={pt ? 'Raízes extras de projetos' : 'Additional project roots'} />
          <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 10px' }}>
            {pt
              ? 'Uma pasta por linha. Use isso para discos e montagens fora do diretório inicial; os caminhos das sessões também são descobertos automaticamente.'
              : 'One folder per line. Use this for disks and mounts outside the home directory; session paths are discovered automatically too.'}
          </p>
          <textarea
            value={scanRootsText}
            onChange={e => { setScanRootsText(e.target.value); setScanRootsMessage('') }}
            rows={4}
            placeholder={pt ? 'D:\\código\n/mnt/d/code' : 'D:\\code\n/mnt/d/code'}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: 9,
              borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-primary)', font: 'inherit', fontSize: 13,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 16 }}>
            {scanRootsMessage && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{scanRootsMessage}</span>}
            <button
              onClick={() => { void saveScanRoots() }}
              disabled={scanRootsSaving}
              style={{
                padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 600,
                border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)',
                color: 'var(--anthropic-orange)', cursor: scanRootsSaving ? 'default' : 'pointer',
                fontFamily: 'inherit', opacity: scanRootsSaving ? 0.6 : 1,
              }}
            >
              {pt ? 'Salvar raízes' : 'Save roots'}
            </button>
          </div>
          <Divider />
        </>
      )}

      {/*  Card order  */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <SectionHeader label={pt ? 'Ordem dos cards' : 'Card order'} />
        <button
          onClick={() => set('cardOrder', [...DEFAULT_CARD_ORDER])}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, marginTop: -14,
            padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <RotateCcw size={9} />{pt ? 'Resetar' : 'Reset'}
        </button>
      </div>
      {/* 2-column drag grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, marginBottom: 4 }}>
        {draft.cardOrder.map(id => (
          <div key={id} draggable
            onDragStart={() => handleDragStart(id)}
            onDragOver={e => handleDragOver(e, id)}
            onDrop={() => handleDrop(id)}
            onDragEnd={handleDragEnd}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderRadius: 6,
              background: dragOver === id ? 'var(--bg-elevated)' : 'transparent',
              border: dragOver === id ? '1px dashed var(--anthropic-orange)' : '1px solid transparent',
              cursor: 'grab', transition: 'background 0.1s, border-color 0.1s', userSelect: 'none',
            }}
          >
            <GripVertical size={11} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{CARD_LABELS[id as CardId]?.[draft.lang] ?? id}</span>
          </div>
        ))}
      </div>

      {/*  Save / Reset row  */}
      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 8,
        marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)',
      }}>
        <button
          onClick={() => setDraft(seedDraft(ctx))}
          disabled={!dirty}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', cursor: dirty ? 'pointer' : 'default',
            fontFamily: 'inherit', transition: 'all 0.15s', opacity: dirty ? 1 : 0.5,
          }}
        >
          <RotateCcw size={13} />{pt ? 'Reverter' : 'Reset'}
        </button>
        <button
          onClick={() => ctx.savePreferences(draft)}
          disabled={!dirty}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600,
            border: '1px solid var(--anthropic-orange)',
            background: 'var(--anthropic-orange-dim)',
            color: 'var(--anthropic-orange)', cursor: dirty ? 'pointer' : 'default',
            fontFamily: 'inherit', transition: 'all 0.15s', opacity: dirty ? 1 : 0.5,
          }}
        >
          <Save size={13} />{pt ? 'Salvar' : 'Save'}
        </button>
      </div>
    </>
  )
}
