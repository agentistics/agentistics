import { CornerDownRight, Check, Terminal, X } from 'lucide-react'
import { useMemo } from 'react'
import { useFleet } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Select } from '../../pages/settings/primitives'
import { SESSION_STATE, field, harnessColor, microLabel, pill } from './board'
import type { Lang } from './copy'

const LIVE = new Set(['working', 'waiting', 'waiting-approval'])

const W = {
  summary: { en: 'Link sessions and break it into subtasks', pt: 'Vincular sessões e quebrar em subtarefas' },
  parts: { en: 'Break it up (optional)', pt: 'Quebrar em partes (opcional)' },
  partPh: { en: 'A piece of it, then Enter', pt: 'Uma parte dela, depois Enter' },
  remove: { en: 'Remove', pt: 'Remover' },
  link: { en: 'Link the sessions already running', pt: 'Vincular as sessões já em andamento' },
  linkHelp: {
    en: 'A session is filed under a PART of the task, never under the task itself — so each one you pick names the part it belongs to.',
    pt: 'Uma sessão é filiada a uma PARTE da tarefa, nunca à tarefa em si — então cada uma que você escolhe diz a que parte pertence.',
  },
  needPart: { en: 'Name a part first (above) so the sessions can be filed under it.', pt: 'Dê nome a uma parte primeiro (acima) para poder filiar as sessões a ela.' },
  none: { en: 'Nothing is running right now. You can file finished conversations from the board later.', pt: 'Nada está rodando agora. Você pode filiar conversas já terminadas pelo quadro depois.' },
  under: { en: 'files under', pt: 'filia em' },
} as const

/**
 * What the old create wizard offered and the plain form must not lose, behind ONE collapsed section:
 * break the task into parts (subtasks) and link the sessions already running, each to a part. The
 * state lives in the dialog (`subs`, `picked` = session id -> index of its part); the writes are
 * `fileExtras` (createFiling.ts). Same rule as the wizard: a session is never filed under the task
 * itself, so picking one needs a part to exist.
 */
export function CreateExtras({ lang, subs, setSubs, picked, setPicked }: {
  lang: Lang
  subs: string[]
  setSubs: (f: (v: string[]) => string[]) => void
  picked: Map<string, number>
  setPicked: (f: (m: Map<string, number>) => Map<string, number>) => void
}) {
  const isMobile = useIsMobile()
  const { fleet } = useFleet(lang)
  const t = <K extends keyof typeof W>(k: K) => W[k][lang]
  const live = useMemo(() => (fleet.sessions ?? []).filter(s => LIVE.has(s.state)), [fleet.sessions])
  const add = (el: HTMLInputElement) => {
    const v = el.value.trim()
    if (v) { setSubs(list => [...list, v]); el.value = ''; }
  }
  return (
    <details data-create-extras style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
      <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, minHeight: isMobile ? 36 : undefined, display: 'flex', alignItems: 'center' }}>
        {t('summary')}{(subs.length > 0 || picked.size > 0) ? ` · ${subs.length}/${picked.size}` : ''}
      </summary>
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>{t('parts')}</span>
          {subs.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12.5 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
              <button
                type="button" aria-label={t('remove')}
                onClick={() => {
                  setSubs(v => v.filter((_, j) => j !== i))
                  // Picks that pointed at this part or a later one shift with the list.
                  setPicked(m => new Map([...m].flatMap(([id, at]) => (at === i ? [] : [[id, at > i ? at - 1 : at] as [string, number]]))))
                }}
                style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex', ...(isMobile ? { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' } : {}) }}
              ><X size={12} /></button>
            </div>
          ))}
          <input
            data-create-part style={field(isMobile)} placeholder={t('partPh')}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(e.currentTarget) } }}
          />
        </div>

        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>{t('link')}</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('linkHelp')}</span>
        </div>
        {subs.length === 0 && live.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{t('needPart')}</div>}
        {live.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('none')}</div>}
        <div style={{ display: 'grid', gap: 3, maxHeight: 210, overflowY: 'auto' }}>
          {live.map(s => {
            const st = SESSION_STATE[s.state]
            const at = picked.get(s.id)
            const on = at !== undefined
            const blocked = !on && subs.length === 0
            return (
              <div key={s.id} style={{ display: 'grid', gap: 4 }}>
                <button
                  type="button" disabled={blocked}
                  onClick={() => setPicked(v => { const n = new Map(v); if (n.has(s.id)) n.delete(s.id); else if (subs.length > 0) n.set(s.id, 0); return n })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)', fontSize: 12.5, minHeight: isMobile ? 44 : 32,
                    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                    opacity: blocked ? 0.5 : 1, cursor: blocked ? 'default' : 'pointer',
                  }}
                >
                  {on ? <Check size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} /> : <Terminal size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
                  <span style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                    <span style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.cwd.split('/').slice(-2).join('/')}</span>
                  </span>
                  <span style={pill(harnessColor(s.harness))}>{s.harness}</span>
                  {st && <span style={pill(st.color)}>{st.label}</span>}
                </button>
                {on && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 12, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                    <CornerDownRight size={12} style={{ flexShrink: 0 }} />
                    <span style={{ flexShrink: 0 }}>{t('under')}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Select value={String(at)} options={subs.map((x, i) => ({ value: String(i), label: x }))} onChange={v => setPicked(m => new Map(m).set(s.id, Number(v)))} />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </details>
  )
}
