/**
 * SessionPresetsSection — manage the saved "quick launch" session templates (ALM board
 * s-d85c7d9d9d, "Sessões pré-configuradas (preset/wake)").
 *
 * A preset saves what a new session needs to start — assistant, first message, optionally a
 * folder/model/effort — so a recurring kind of task can be launched from the Sessions workspace's
 * `FleetOverview` with one click instead of walking the full wizard every time. See
 * `@agentistics/core`'s `sessionPresets.ts` for the shape and the pure validate/normalize helpers,
 * and `PresetShelf.tsx` for where these are actually launched.
 *
 * Rendered inside `SessionsSettings.tsx` — this is a SECTION of the existing Sessions settings
 * page, not a new settings screen or a modal (CLAUDE.md: the settings pages, one per section, are
 * the single place machine-level configuration lives).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  MAX_SESSION_PRESETS, removeSessionPreset, upsertSessionPreset, validatePresetDraft,
  type PresetDraftIssue, type SessionPreset,
} from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_LABELS } from '../../lib/harness'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { useIsMobile } from '../../hooks/useIsMobile'
import { ConfirmModal, Divider, FieldInput, SectionHeader, Select } from './primitives'

interface HarnessChoice { id: string; label: string }

interface Draft {
  label: string
  harness: string
  promptTemplate: string
  cwd: string
  model: string
  effort: string
}

const EMPTY_DRAFT: Draft = { label: '', harness: '', promptTemplate: '', cwd: '', model: '', effort: '' }

function draftOf(p: SessionPreset): Draft {
  return { label: p.label, harness: p.harness, promptTemplate: p.promptTemplate, cwd: p.cwd ?? '', model: p.model ?? '', effort: p.effort ?? '' }
}

export default function SessionPresetsSection() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()
  // A central hosts no sessions of its own — there is nowhere a preset here could ever launch.
  // Same reasoning `editorCentral` uses a few lines above in `SessionsSettings.tsx`.
  const central = ctx.isCentral

  // The harnesses THIS machine can actually start — the same list the new-session wizard reads off
  // `/api/fleet/new`, so a preset can never be saved naming an assistant this machine cannot spawn.
  const [harnesses, setHarnesses] = useState<HarnessChoice[] | null>(null)
  useEffect(() => {
    if (central) return
    let alive = true
    fetch(`/api/fleet/new?lang=${ctx.lang}`)
      .then(r => (r.ok ? r.json() : null))
      .then((json: { harnesses?: { id: string; label: string }[] } | null) => {
        if (alive) setHarnesses(json?.harnesses?.map(h => ({ id: h.id, label: h.label })) ?? [])
      })
      .catch(() => { if (alive) setHarnesses([]) })
    return () => { alive = false }
  }, [central, ctx.lang])

  const harnessOptions = useMemo(
    () => (harnesses ?? []).map(h => ({ value: h.id, label: (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label })),
    [harnesses],
  )

  /** `null` = not editing. `'new'` = the create form. Otherwise the id of the preset being edited. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const ISSUE_TEXT: Record<PresetDraftIssue, string> = {
    label: pt ? 'Dê um nome a este preset.' : 'Give this preset a name.',
    harness: pt ? 'Escolha um assistente.' : 'Pick an assistant.',
    prompt: pt ? 'Escreva a primeira mensagem.' : 'Write the first message.',
    cwd_relative: pt
      ? 'A pasta precisa ser um caminho absoluto (começando com /).'
      : 'The folder must be an absolute path (starting with /).',
  }

  function startCreate() {
    setDraft(EMPTY_DRAFT)
    setEditingId('new')
    setError(null)
  }
  function startEdit(p: SessionPreset) {
    setDraft(draftOf(p))
    setEditingId(p.id)
    setError(null)
  }
  function cancel() {
    setEditingId(null)
    setError(null)
  }

  async function save() {
    const check = validatePresetDraft(draft)
    if (!check.ok) { setError(ISSUE_TEXT[check.issue]); return }
    setSaving(true)
    setError(null)
    const id = editingId === 'new' ? crypto.randomUUID() : editingId!
    const next: SessionPreset = {
      id,
      label: draft.label.trim(),
      harness: draft.harness.trim(),
      promptTemplate: draft.promptTemplate.trim(),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}),
    }
    try {
      await ctx.saveSessionPresets(upsertSessionPreset(ctx.sessionPresets, next))
      setEditingId(null)
    } catch {
      setError(pt ? 'Erro de rede ao salvar.' : 'Network error saving.')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!confirmDeleteId) return
    const id = confirmDeleteId
    setConfirmDeleteId(null)
    if (editingId === id) setEditingId(null)
    await ctx.saveSessionPresets(removeSessionPreset(ctx.sessionPresets, id))
  }

  if (central) {
    return (
      <div>
        <SectionHeader label={pt ? 'Sessões pré-configuradas' : 'Session presets'} />
        <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
          {pt
            ? 'Indisponível neste central: ele agrega métricas de outras máquinas e não hospeda sessões próprias — não há onde disparar um preset aqui. Configure presets na máquina onde as sessões rodam.'
            : 'Unavailable on a central: it aggregates other machines’ metrics and hosts no sessions of its own — there is nowhere to launch a preset here. Configure presets on the machine sessions actually run on.'}
        </p>
        <Divider />
      </div>
    )
  }

  const cancelBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: isMobile ? '0 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
    width: isMobile ? '100%' : undefined,
    borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  }
  const saveBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: isMobile ? '0 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
    width: isMobile ? '100%' : undefined,
    borderRadius: 7, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)',
    color: 'var(--anthropic-orange)', fontSize: 12.5, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', opacity: saving ? 0.6 : 1,
  }
  // `.ag-tap-icon` PROJECTS the 44px touch target rather than painting it — the control keeps its
  // natural 28px size on every screen and the class adds an invisible hit box around it on mobile.
  // See touchTarget.lint.test.ts's own header for why a painted `width/height: isMobile ? 44` icon
  // square is refused outright.
  //
  // `--ag-tap-grow: 0` on BOTH buttons, set inline on the element itself (a class rule on the same
  // element always wins over an ancestor's value for a custom property, so this cannot be set on a
  // wrapping div — see `RepoTreeView.tsx`'s own worked example). The default 7px-a-side growth
  // would make the projected hit boxes of two 28px buttons 6px apart OVERLAP (index.css's own
  // example), and the neighbour here is Delete — an accidental destructive tap is worse than a
  // slightly smaller Edit target.
  const iconBtn = (danger?: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: 28, height: 28, borderRadius: 7,
    border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer',
    color: danger ? 'var(--accent-red)' : 'var(--text-tertiary)',
    ['--ag-tap-grow' as string]: '0px',
  })

  return (
    <div>
      <SectionHeader label={pt ? 'Sessões pré-configuradas' : 'Session presets'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'Um modelo salvo de sessão — assistente, primeira mensagem e, opcionalmente, pasta/modelo/esforço — para disparar com um clique na aba Sessões, em vez de preencher o assistente do zero toda vez. Lá eles aparecem como uma vitrine própria, separada da lista de sessões: um preset não é uma sessão, e disparar um inicia um assistente de verdade, cobrado como qualquer outro — a vitrine sempre pede confirmação antes.'
          : 'A saved session template — assistant, first message and, optionally, a folder/model/effort — to launch with one click from the Sessions tab, instead of filling the assistant wizard out from scratch every time. There it shows up as its own shelf, separate from the session list: a preset is not a session, and launching one starts a real assistant, billed like any other — the shelf always confirms first.'}
      </p>

      {ctx.sessionPresets.length === 0 && editingId === null && (
        <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginBottom: 12 }}>
          {pt ? 'Nenhum preset ainda.' : 'No presets yet.'}
        </p>
      )}

      {ctx.sessionPresets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {ctx.sessionPresets.map(p => (editingId === p.id ? null : (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-card)',
            }}>
              <HarnessMark harness={p.harness} size={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {(HARNESS_LABELS as Record<string, string>)[p.harness] ?? p.harness}
                  {' · '}
                  {p.cwd ?? (pt ? 'pede a pasta ao disparar' : 'asks for a folder when launched')}
                </div>
              </div>
              <button type="button" className="ag-tap-icon" onClick={() => startEdit(p)} aria-label={pt ? 'Editar' : 'Edit'} style={iconBtn()}>
                <Pencil size={14} />
              </button>
              <button type="button" className="ag-tap-icon" onClick={() => setConfirmDeleteId(p.id)} aria-label={pt ? 'Excluir' : 'Delete'} style={iconBtn(true)}>
                <Trash2 size={14} />
              </button>
            </div>
          )))}
        </div>
      )}

      {editingId !== null ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 14, background: 'var(--bg-card)' }}>
          <FieldInput
            label={pt ? 'Nome' : 'Name'}
            value={draft.label}
            onChange={v => setDraft(d => ({ ...d, label: v }))}
            placeholder={pt ? 'ex.: Corrigir teste flaky' : 'e.g. Fix flaky test'}
          />
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {pt ? 'Assistente' : 'Assistant'}
            </div>
            <Select
              value={draft.harness}
              onChange={v => setDraft(d => ({ ...d, harness: v }))}
              options={harnessOptions}
              placeholder={harnesses === null
                ? (pt ? 'Vendo o que está instalado…' : 'Checking what is installed…')
                : (pt ? 'Escolher…' : 'Pick…')}
              disabled={harnesses === null}
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {pt ? 'Primeira mensagem' : 'First message'}
            </div>
            <textarea
              value={draft.promptTemplate}
              onChange={e => setDraft(d => ({ ...d, promptTemplate: e.target.value }))}
              rows={3}
              placeholder={pt ? 'O que a sessão deve fazer…' : 'What the session should do…'}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
                fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit',
                resize: 'vertical', minHeight: 64,
              }}
            />
          </div>
          <FieldInput
            label={pt ? 'Pasta (opcional)' : 'Folder (optional)'}
            sub={pt
              ? 'Caminho absoluto. Em branco, a vitrine pede a pasta ao disparar.'
              : 'Absolute path. Left blank, the shelf asks for a folder when launched.'}
            value={draft.cwd}
            onChange={v => setDraft(d => ({ ...d, cwd: v }))}
            placeholder="/home/user/repo"
          />
          <FieldInput
            label={pt ? 'Modelo (opcional)' : 'Model (optional)'}
            value={draft.model}
            onChange={v => setDraft(d => ({ ...d, model: v }))}
          />
          <FieldInput
            label={pt ? 'Esforço (opcional)' : 'Effort (optional)'}
            value={draft.effort}
            onChange={v => setDraft(d => ({ ...d, effort: v }))}
          />
          {error && <p role="alert" style={{ fontSize: 12, color: 'var(--accent-red)', margin: '0 0 10px' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row' }}>
            <button type="button" onClick={cancel} disabled={saving} style={cancelBtn}>{pt ? 'Cancelar' : 'Cancel'}</button>
            <button type="button" onClick={save} disabled={saving} style={saveBtn}>
              {saving ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Salvar' : 'Save')}
            </button>
          </div>
        </div>
      ) : ctx.sessionPresets.length < MAX_SESSION_PRESETS && (
        <button
          type="button"
          onClick={startCreate}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : undefined, justifyContent: isMobile ? 'center' : 'flex-start',
            borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <Plus size={14} /> {pt ? 'Novo preset' : 'New preset'}
        </button>
      )}

      <ConfirmModal
        open={confirmDeleteId !== null}
        title={pt ? 'Excluir preset' : 'Delete preset'}
        message={pt
          ? 'Isso remove o preset da vitrine de disparo. Sessões já iniciadas não são afetadas.'
          : 'This removes the preset from the launch shelf. Sessions already started are unaffected.'}
        confirmLabel={pt ? 'Excluir' : 'Delete'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />

      <Divider />
    </div>
  )
}
