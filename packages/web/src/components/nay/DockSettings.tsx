/**
 * DockSettings.tsx — the gear in the Nay dock's header, and the small popover it opens.
 *
 * It holds the options that belong to THIS widget and nothing else (owner, 2026-09-29):
 *  - the look of the chat button while it is dragged (`NAY_FAB_STYLES`);
 *  - whether it snaps to the nearest edge on release (always, on a phone);
 *  - putting the button back where it started;
 *  - the model a NEW Nay conversation starts with and the reply sound — the two chat options
 *    that act on this widget directly.
 * Everything else about the chat stays in Settings -> Chat, which this links to rather than
 * copying: two places to change one setting is two places for them to disagree.
 *
 * The model and the sound are written the way `ChatSettings.tsx` writes them (a PUT to
 * `/api/preferences` plus the live setter on the app context), so both screens read one value.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, RotateCcw, Settings2 } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useChatHarnesses } from '../../hooks/useChatHarnesses'
import { CHAT_SOUNDS, findChatSound } from '../../lib/chatSounds'
import { getNotificationSettings } from '../../lib/sessionNotifications'
import { NAY_FAB_STYLES, NAY_FAB_STYLE_LABEL, type NayFabPrefs } from '../../lib/nayFab'

type ChatCtx = Pick<AppContext, 'chatModel' | 'setChatModel' | 'chatSoundEnabled' | 'setChatSoundEnabled' | 'chatSoundId' | 'setChatSoundId'>

export interface DockSettingsProps {
  pt: boolean
  isMobile: boolean
  prefs: NayFabPrefs
  onPrefs: (next: NayFabPrefs) => void
  chat: ChatCtx
  /** Called before leaving for the full Settings screen, so the dock can get out of the way. */
  onLeave: () => void
}

function putPreference(body: Record<string, unknown>): void {
  void fetch('/api/preferences', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {})
}

export function DockSettings({ pt, isMobile, prefs, onPrefs, chat, onLeave }: DockSettingsProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { harnesses } = useChatHarnesses()
  const models = harnesses.find(h => h.id === 'claude')?.models ?? []
  const audioRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  const preview = (id: string) => {
    if (!audioRef.current) { try { audioRef.current = new AudioContext() } catch { return } }
    findChatSound(id).play(audioRef.current, getNotificationSettings().soundVolume)
  }

  const currentModel = chat.chatModel ?? models[0]?.id ?? ''

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={pt ? 'Ajustes do chat' : 'Chat settings'}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={pt ? 'Ajustes do chat' : 'Chat settings'}
        className={isMobile ? 'ag-tap-icon' : undefined}
        style={{
          width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none',
          borderRadius: 7, cursor: 'pointer', color: open ? 'var(--text-primary)' : 'var(--text-secondary)',
          background: open ? 'var(--bg-hover, rgba(127,127,127,0.1))' : 'transparent',
        }}
      >
        <Settings2 size={15} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={pt ? 'Ajustes do chat' : 'Chat settings'}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 288, maxWidth: 'calc(100vw - 24px)',
            zIndex: 20, background: 'var(--bg-elevated, var(--bg-surface))', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)',
            padding: 12, display: 'flex', flexDirection: 'column', gap: 12, animation: 'ag-fade-in 120ms ease-out',
          }}
        >
          <Section title={pt ? 'Botão do chat' : 'Chat button'}>
            <div role="radiogroup" aria-label={pt ? 'Animação ao arrastar' : 'Drag animation'}
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {NAY_FAB_STYLES.map(s => {
                const on = prefs.style === s
                return (
                  <button key={s} type="button" role="radio" aria-checked={on}
                    onClick={() => onPrefs({ ...prefs, style: s })}
                    style={{
                      padding: isMobile ? '12px 8px' : '7px 8px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: 12, fontWeight: on ? 600 : 500, textAlign: 'center',
                      border: `1px solid ${on ? 'var(--text-secondary)' : 'var(--border)'}`,
                      background: on ? 'var(--bg-hover, rgba(127,127,127,0.1))' : 'transparent',
                      color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}>
                    {NAY_FAB_STYLE_LABEL[s][pt ? 'pt' : 'en']}
                  </button>
                )
              })}
            </div>
            <Row label={pt ? 'Encostar na borda ao soltar' : 'Snap to the nearest edge'}
              hint={isMobile ? (pt ? 'Sempre ligado no celular' : 'Always on on a phone') : undefined}>
              <Switch on={isMobile || prefs.snap} disabled={isMobile} onToggle={() => onPrefs({ ...prefs, snap: !prefs.snap })}
                label={pt ? 'Encostar na borda' : 'Snap to edge'} />
            </Row>
            <button type="button" onClick={() => onPrefs({ ...prefs, pos: null })} disabled={prefs.pos === null}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', padding: '5px 8px', borderRadius: 7,
                border: '1px solid var(--border)', background: 'transparent', fontFamily: 'inherit', fontSize: 12,
                color: prefs.pos === null ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                cursor: prefs.pos === null ? 'default' : 'pointer',
              }}>
              <RotateCcw size={12} />{pt ? 'Voltar o botão ao lugar' : 'Reset the button position'}
            </button>
          </Section>

          <Section title={pt ? 'Conversas da Nay' : 'Nay conversations'}>
            <Row label={pt ? 'Modelo das novas conversas' : 'Model for new conversations'}>
              <select
                aria-label={pt ? 'Modelo das novas conversas' : 'Model for new conversations'}
                value={currentModel}
                disabled={models.length === 0}
                onChange={e => { chat.setChatModel(e.target.value); putPreference({ chatModel: e.target.value }) }}
                style={selectStyle}
              >
                {models.length === 0 && <option value="">{pt ? 'Carregando…' : 'Loading…'}</option>}
                {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Row>
            <Row label={pt ? 'Som ao responder' : 'Sound on reply'}>
              <Switch on={chat.chatSoundEnabled} label={pt ? 'Som ao responder' : 'Sound on reply'} onToggle={() => {
                const next = !chat.chatSoundEnabled
                chat.setChatSoundEnabled(next)
                putPreference({ chatSoundEnabled: next })
                if (next) preview(chat.chatSoundId)
              }} />
            </Row>
            {chat.chatSoundEnabled && (
              <select
                aria-label={pt ? 'Qual som' : 'Which sound'}
                value={chat.chatSoundId}
                onChange={e => { chat.setChatSoundId(e.target.value); putPreference({ chatSoundId: e.target.value }); preview(e.target.value) }}
                style={{ ...selectStyle, width: '100%' }}
              >
                {CHAT_SOUNDS.map(s => <option key={s.id} value={s.id}>{s.label[pt ? 'pt' : 'en']}</option>)}
              </select>
            )}
          </Section>

          <button type="button" onClick={() => { setOpen(false); onLeave(); navigate('/settings/chat') }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start', border: 'none', padding: 0,
              background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
              textDecoration: 'underline', textUnderlineOffset: 3,
            }}>
            {pt ? 'Todos os ajustes do chat' : 'All chat settings'}<ArrowUpRight size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

const selectStyle = {
  fontFamily: 'inherit', fontSize: 12, padding: '4px 6px', borderRadius: 6, maxWidth: 150,
  border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)',
} as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{title}</div>
      {children}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Switch({ on, onToggle, disabled, label }: { on: boolean; onToggle: () => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => { if (!disabled) onToggle() }}
      className="ag-switch"
      style={{
        position: 'relative', width: 32, height: 18, flexShrink: 0, borderRadius: 9, border: 'none', padding: 0,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        background: on ? 'var(--anthropic-orange)' : 'var(--border)',
      }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: '50%',
        background: '#fff', transition: 'left 120ms ease',
      }} />
    </button>
  )
}
