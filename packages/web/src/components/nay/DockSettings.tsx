/**
 * DockSettings.tsx — the gear in the Nay dock's header, and the small popover it opens.
 *
 * It holds the options that belong to THIS widget and nothing else (owner, 2026-09-29):
 *  - the look of the chat button while it is dragged (`NAY_FAB_STYLES`);
 *  - the EDGE MAGNET: whether an edge pulls the button in when it is dropped close to it (the
 *    stored field is still `snap`, so no saved choice is lost). The same on a phone as on a desktop;
 *  - putting the button back where it started;
 *  - what a NEW Nay conversation starts with (assistant, model, effort) and the reply sound — the chat options
 *    that act on this widget directly.
 * Everything else about the chat stays in Settings -> Chat, which this links to rather than
 * copying: two places to change one setting is two places for them to disagree.
 *
 * The model and the sound are written the way `ChatSettings.tsx` writes them (a PUT to
 * `/api/preferences` plus the live setter on the app context), so both screens read one value.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, RotateCcw, Settings2 } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useNayDefaults, useNayHarnesses, saveNayDefaults } from '../../hooks/useNayDefaults'
import { normalizeChoice } from '../../lib/nayLaunch'
import { NayLaunchFields } from './NayLaunchFields'
import { CHAT_SOUNDS, findChatSound } from '../../lib/chatSounds'
import { getNotificationSettings, saveNotificationSettings, subscribeNotificationSettings } from '../../lib/sessionNotifications'
import { AUTO_DISMISS_OPTIONS_SEC, NAY_ANIMATIONS, NAY_ANIMATION_HINT, NAY_ANIMATION_LABEL, type NayAnimation } from '../../lib/nayNotify'
import { NAY_FAB_STYLES, NAY_FAB_STYLE_LABEL, type NayFabPrefs } from '../../lib/nayFab'
import { Select } from '../../pages/settings/primitives'
import { NayMotionSettings } from './NayMotionSettings'

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

export interface DockSettingsButtonProps {
  pt: boolean
  isMobile: boolean
  open: boolean
  onToggle: () => void
}

/**
 * The gear in the dock's header. It used to open a dropdown the owner found hard to use (2026-09-30);
 * it now opens the chat window's own SETTINGS SCREEN (`DockSettingsScreen`), which replaces the
 * conversation until its back button is pressed.
 */
export function DockSettings({ pt, isMobile, open, onToggle }: DockSettingsButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={pt ? 'Ajustes do chat' : 'Chat settings'}
      aria-pressed={open}
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
  )
}

/**
 * The chat window's settings SCREEN: three sections (the chat button, session notifications, Nay
 * conversations), scrolling inside the window, with a back button. `Escape` goes back too, unless a
 * `Select` inside is open — that one closes itself first.
 */
export function DockSettingsScreen({ pt, isMobile, prefs, onPrefs, chat, onLeave, onBack }: DockSettingsProps & { onBack: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const harnesses = useNayHarnesses(pt ? 'pt' : 'en', true)
  const defaults = useNayDefaults()
  const audioRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (rootRef.current?.querySelector('[role="listbox"]')) return
      e.stopPropagation(); onBack()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onBack])

  const preview = (id: string) => {
    if (!audioRef.current) { try { audioRef.current = new AudioContext() } catch { return } }
    findChatSound(id).play(audioRef.current, getNotificationSettings().soundVolume)
  }

  // The session notifications' own switches that belong to this button. Stored in the notification
  // settings (`/api/preferences`), so Settings -> Chat and Settings -> Notifications read the same values.
  const [notify, setNotify] = useState(getNotificationSettings)
  useEffect(() => subscribeNotificationSettings(() => setNotify(getNotificationSettings())), [])
  const saveNotify = (patch: Partial<typeof notify>) => {
    const next = { ...getNotificationSettings(), ...patch }
    setNotify(next)
    saveNotificationSettings(next)
  }

  return (
    <div ref={rootRef} role="region" aria-label={pt ? 'Ajustes do chat' : 'Chat settings'}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button type="button" onClick={onBack} aria-label={pt ? 'Voltar à conversa' : 'Back to the conversation'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, minHeight: isMobile ? 44 : 30, padding: '0 8px', borderRadius: 7,
            border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
          }}>
          <ArrowLeft size={15} />{pt ? 'Voltar' : 'Back'}
        </button>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Ajustes do chat' : 'Chat settings'}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? 16 : 14, display: 'flex', flexDirection: 'column', gap: 18 }}>
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
            {/* The window and the notification card each follow the button with their OWN motion,
                inheriting this one until somebody picks another (owner, 2026-09-30). */}
            <NayMotionSettings pt={pt} />
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
            <Row label={pt ? 'Some sozinho após' : 'Goes away after'}
              hint={pt ? 'Fica enquanto você usa o cartão; sempre fica no sino' : 'Stays while you use the card; always kept in the bell'}>
              <div style={{ minWidth: 110 }}>
                <Select value={String(notify.autoDismissSec)} onChange={v => saveNotify({ autoDismissSec: Number(v) })}
                  options={AUTO_DISMISS_OPTIONS_SEC.map(n => ({ value: String(n), label: n === 0 ? (pt ? 'Nunca' : 'Never') : `${n} s` }))} />
              </div>
            </Row>
          </Section>

          <Section title={pt ? 'Conversas da Nay' : 'Nay conversations'}>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{pt ? 'Novas conversas começam com' : 'New conversations start with'}</div>
            {harnesses && defaults ? (
              <NayLaunchFields layout="stack" pt={pt} harnesses={harnesses}
                value={normalizeChoice(defaults, harnesses)} onChange={saveNayDefaults} />
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pt ? 'Carregando…' : 'Loading…'}</div>
            )}
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

          <button type="button" onClick={() => { onBack(); onLeave(); navigate('/settings/chat') }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start', border: 'none', padding: 0,
              background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
              textDecoration: 'underline', textUnderlineOffset: 3,
            }}>
            {pt ? 'Todos os ajustes do chat' : 'All chat settings'}<ArrowUpRight size={12} />
          </button>
      </div>
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
