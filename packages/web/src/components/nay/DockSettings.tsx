/**
 * DockSettings.tsx — the gear in the Nay dock's header, and the small popover it opens.
 *
 * It holds the options that belong to THIS widget and nothing else (owner, 2026-09-29):
 *  - the look of the chat button while it is dragged (`NAY_FAB_STYLES`);
 *  - the EDGE MAGNET: whether an edge pulls the button in when it is dropped close to it (the
 *    stored field is still `snap`, so no saved choice is lost). The same on a phone as on a desktop;
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
import { getNotificationSettings, saveNotificationSettings, subscribeNotificationSettings } from '../../lib/sessionNotifications'
import { NAY_ANIMATIONS, NAY_ANIMATION_HINT, NAY_ANIMATION_LABEL, type NayAnimation } from '../../lib/nayNotify'
import { Select } from '../../pages/settings/primitives'
import { NAY_FAB_STYLES, NAY_FAB_STYLE_LABEL, type NayFabPrefs } from '../../lib/nayFab'
import { Select } from '../../pages/settings/primitives'

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // An open Select inside closes itself first; only a second Escape closes this popover.
      if (rootRef.current?.querySelector('[role="listbox"]')) return
      e.stopPropagation(); setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  const preview = (id: string) => {
    if (!audioRef.current) { try { audioRef.current = new AudioContext() } catch { return } }
    findChatSound(id).play(audioRef.current, getNotificationSettings().soundVolume)
  }

  const currentModel = chat.chatModel ?? models[0]?.id ?? ''

  // The session notifications' own two switches that belong to this button: how it speaks a card,
  // and do-not-disturb. Stored in the notification settings, so Settings -> Chat and Settings ->
  // Notifications read the very same values.
  const [notify, setNotify] = useState(getNotificationSettings)
  useEffect(() => subscribeNotificationSettings(() => setNotify(getNotificationSettings())), [])
  const saveNotify = (patch: Partial<typeof notify>) => {
    const next = { ...getNotificationSettings(), ...patch }
    setNotify(next)
    saveNotificationSettings(next)
  }

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
            <Row label={pt ? 'Ímã nas bordas' : 'Edge magnet'}
              hint={pt ? 'Solto perto de uma borda, o botão encosta nela' : 'Dropped near an edge, the button snaps to it'}>
              <Switch on={prefs.snap} onToggle={() => onPrefs({ ...prefs, snap: !prefs.snap })}
                label={pt ? 'Ímã nas bordas' : 'Edge magnet'} />
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

          <Section title={pt ? 'Notificações das sessões' : 'Session notifications'}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{pt ? 'Como o botão avisa' : 'How the button tells you'}</div>
              <Select
                value={notify.nayAnimation}
                onChange={v => saveNotify({ nayAnimation: v as NayAnimation })}
                options={NAY_ANIMATIONS.map(a => ({ value: a, label: NAY_ANIMATION_LABEL[a][pt ? 'pt' : 'en'] }))}
              />
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{NAY_ANIMATION_HINT[notify.nayAnimation][pt ? 'pt' : 'en']}</div>
            </div>
            <Row label={pt ? 'Não perturbe' : 'Do not disturb'}
              hint={pt ? 'Sem cartão nem som; tudo fica no sino' : 'No card or sound; everything stays in the bell'}>
              <Switch on={notify.doNotDisturb} label={pt ? 'Não perturbe' : 'Do not disturb'}
                onToggle={() => saveNotify({ doNotDisturb: !notify.doNotDisturb })} />
            </Row>
          </Section>

          <Section title={pt ? 'Conversas da Nay' : 'Nay conversations'}>
            <Row label={pt ? 'Modelo das novas conversas' : 'Model for new conversations'}>
              <div style={{ width: 156, flexShrink: 0 }} aria-label={pt ? 'Modelo das novas conversas' : 'Model for new conversations'}>
                <Select
                  value={currentModel}
                  disabled={models.length === 0}
                  placeholder={pt ? 'Carregando…' : 'Loading…'}
                  searchPlaceholder={pt ? 'Buscar modelo…' : 'Search models…'}
                  options={models.map(m => ({ value: m.id, label: m.label }))}
                  onChange={v => { chat.setChatModel(v); putPreference({ chatModel: v }) }}
                />
              </div>
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
              <div aria-label={pt ? 'Qual som' : 'Which sound'}>
                <Select
                  value={chat.chatSoundId}
                  options={CHAT_SOUNDS.map(s => ({ value: s.id, label: s.label[pt ? 'pt' : 'en'] }))}
                  onChange={v => { chat.setChatSoundId(v); putPreference({ chatSoundId: v }); preview(v) }}
                />
              </div>
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
