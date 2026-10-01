/**
 * NaySettingsPanel.tsx — every choice about the Nay button, its notifications and its
 * conversations, in ONE component drawn in both places they are changed: the chat window's settings
 * screen (`DockSettingsScreen`) and Settings → Chat. Two copies had drifted into two different
 * orders, labels and subsets, and the owner found them "messy, hard to understand, and impossible to
 * test in combination" (2026-09-30).
 *
 * THREE GROUPS, by what the person is thinking about, not by where a value is stored:
 *  - BUTTON — how the button moves when dragged, how the open window follows it, the edge magnet,
 *    putting it back in its corner;
 *  - NOTIFICATIONS — how a card appears, how it follows the button, its sounds, how long it stays,
 *    do-not-disturb — and a PREVIEW (`previewNayNotification`) that plays the current combination;
 *  - NAY CONVERSATIONS — the assistant, model and effort a new conversation starts with, and the
 *    sound when it replies.
 * Every choice carries ONE plain line saying what it does, and every sound has a play button beside
 * it: a sound picked from a name is a sound nobody has heard.
 *
 * It holds no storage of its own: each value is read from and written to the store it always lived
 * in (`nayFabPrefsStore`, `sessionNotifications`, `useNayDefaults`, the chat preferences), so the
 * two screens show one value and nothing already saved moves.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Play, RotateCcw, Sparkles } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useNayDefaults, useNayHarnesses, saveNayDefaults } from '../../hooks/useNayDefaults'
import { normalizeChoice } from '../../lib/nayLaunch'
import { NayLaunchFields } from './NayLaunchFields'
import { CHAT_SOUNDS, findChatSound } from '../../lib/chatSounds'
import {
  getNotificationSettings, playNotificationSound, previewNayNotification, saveNotificationSettings,
  subscribeNotificationSettings, type NotificationSettings, type SoundPreset,
} from '../../lib/sessionNotifications'
import { SOUND_PRESET_OPTIONS } from '../../lib/soundPresetOptions'
import { AUTO_DISMISS_OPTIONS_SEC, NAY_ANIMATIONS, NAY_ANIMATION_HINT, NAY_ANIMATION_LABEL, type NayAnimation } from '../../lib/nayNotify'
import { NAY_FAB_STYLES, NAY_FAB_STYLE_LABEL, isNayFabStyle, type NayFabPrefs, type NayFabStyle } from '../../lib/nayFab'
import { setNayFabPrefs, useNayFabPrefs } from '../../lib/nayFabPrefsStore'
import { Select } from '../../pages/settings/primitives'

export type ChatSoundCtx = Pick<AppContext, 'chatSoundEnabled' | 'setChatSoundEnabled' | 'chatSoundId' | 'setChatSoundId'>

export interface NaySettingsPanelProps {
  pt: boolean
  isMobile: boolean
  /** `stack`: label and line above a full-width control (the chat window, a phone). `rows`: control beside it. */
  layout: 'stack' | 'rows'
  chat: ChatSoundCtx
  /** Show the Nay conversations group. Settings → Chat hides it while chat is switched off. */
  conversations?: boolean
}

const INHERIT = 'inherit'

/** One line per drag style — what the person will actually see. */
const STYLE_HINT: Record<NayFabStyle, { pt: string; en: string }> = {
  jelly: { pt: 'Estica na direção do movimento e balança ao parar.', en: 'Stretches toward its motion and wobbles when it stops.' },
  trail: { pt: 'Deixa um rastro elástico que alcança o botão.', en: 'Leaves an elastic trail that catches up with it.' },
  shock: { pt: 'Firme; dá um pequeno impacto ao pousar.', en: 'Firm; gives a small impact when it lands.' },
  comet: { pt: 'Inclina no movimento e deixa uma cauda.', en: 'Leans into its motion and leaves a tail.' },
}

/** The three notifications that come out of the button, each with its own sound. */
const CARD_EVENTS: { key: 'waiting' | 'waiting-approval' | 'stale'; pt: string; en: string; hintPt: string; hintEn: string }[] = [
  { key: 'waiting', pt: 'Precisa de você', en: 'Needs you', hintPt: 'Uma sessão terminou a vez e espera sua resposta.', hintEn: 'A session finished its turn and waits for your answer.' },
  { key: 'waiting-approval', pt: 'Pede aprovação', en: 'Needs approval', hintPt: 'Uma sessão pede permissão para seguir.', hintEn: 'A session asks for permission to go on.' },
  { key: 'stale', pt: 'Sem abrir', en: 'Not opened', hintPt: 'Lembrete de uma sessão que espera há tempo e ninguém abriu.', hintEn: 'A reminder about a session that has waited a while unopened.' },
]

function putPreference(body: Record<string, unknown>): void {
  void fetch('/api/preferences', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {})
}

export function NaySettingsPanel({ pt, isMobile, layout, chat, conversations = true }: NaySettingsPanelProps) {
  const lang = pt ? 'pt' : 'en'
  const prefs = useNayFabPrefs()
  const harnesses = useNayHarnesses(lang, true)
  const defaults = useNayDefaults()
  const [notify, setNotify] = useState<NotificationSettings>(getNotificationSettings)
  useEffect(() => subscribeNotificationSettings(() => setNotify(getNotificationSettings())), [])
  const saveNotify = (patch: Partial<NotificationSettings>) => {
    const next = { ...getNotificationSettings(), ...patch }
    setNotify(next)
    saveNotificationSettings(next)
  }
  const setPrefs = (next: NayFabPrefs) => setNayFabPrefs(next)
  const setFollow = (key: 'dockStyle' | 'cardStyle', v: string) => {
    const next: NayFabPrefs = { ...prefs }
    if (isNayFabStyle(v)) next[key] = v
    else delete next[key]
    setPrefs(next)
  }

  const audioRef = useRef<AudioContext | null>(null)
  const playChat = (id: string) => {
    if (!audioRef.current) { try { audioRef.current = new AudioContext() } catch { return } }
    findChatSound(id).play(audioRef.current, getNotificationSettings().soundVolume)
  }

  const styleOptions = NAY_FAB_STYLES.map(s => ({ value: s, label: NAY_FAB_STYLE_LABEL[s][lang] }))
  const inheritOption = { value: INHERIT, label: pt ? `Igual ao botão (${NAY_FAB_STYLE_LABEL[prefs.style].pt})` : `Same as the button (${NAY_FAB_STYLE_LABEL[prefs.style].en})` }
  const soundOptions = SOUND_PRESET_OPTIONS.map(o => ({ value: o.key, label: pt ? o.labelPt : o.labelEn }))
  const soundAbout = (k: SoundPreset) => {
    const o = SOUND_PRESET_OPTIONS.find(x => x.key === k)
    return o ? (pt ? o.descPt : o.descEn).replace(/\.+$/, '') : ''
  }
  const tap = isMobile ? 44 : 32
  const choice = (label: string, hint: string, control: ReactNode, wide = true) => (
    <Choice key={label} label={label} hint={hint} control={control} layout={layout} wide={wide} />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── BUTTON ─────────────────────────────────────────────────────────────── */}
      <Group title={pt ? 'Botão' : 'Button'}
        about={pt ? 'O botão flutuante da Nay: como ele se move e onde fica.' : 'The floating Nay button: how it moves and where it sits.'}>
        <div>
          <Label text={pt ? 'Ao arrastar' : 'When dragged'} hint={STYLE_HINT[prefs.style][lang]} />
          <div role="radiogroup" aria-label={pt ? 'Ao arrastar' : 'When dragged'}
            style={{ display: 'grid', gridTemplateColumns: layout === 'rows' && !isMobile ? 'repeat(4, 1fr)' : '1fr 1fr', gap: 6, marginTop: 6 }}>
            {NAY_FAB_STYLES.map(s => {
              const on = prefs.style === s
              return (
                <button key={s} type="button" role="radio" aria-checked={on} title={STYLE_HINT[s][lang]}
                  onClick={() => setPrefs({ ...prefs, style: s })}
                  style={{
                    minHeight: tap, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 12.5, fontWeight: on ? 700 : 500,
                    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                    color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                  }}>
                  {NAY_FAB_STYLE_LABEL[s][lang]}
                </button>
              )
            })}
          </div>
        </div>
        {choice(
          pt ? 'A janela aberta acompanha com' : 'The open window follows with',
          pt ? 'Como a janela do chat segue o botão enquanto você o arrasta.' : 'How the chat window follows the button while you drag it.',
          <Select value={prefs.dockStyle ?? INHERIT} onChange={v => setFollow('dockStyle', v)} options={[inheritOption, ...styleOptions]} />,
        )}
        {choice(
          pt ? 'Ímã nas bordas' : 'Edge magnet',
          pt ? 'Solto perto de uma borda, o botão encosta nela.' : 'Dropped near an edge, the button snaps to it.',
          <Switch on={prefs.snap} label={pt ? 'Ímã nas bordas' : 'Edge magnet'} tap={tap}
            onToggle={() => setPrefs({ ...prefs, snap: !prefs.snap })} />,
          false,
        )}
        {choice(
          pt ? 'Lugar do botão' : 'Button position',
          prefs.pos === null
            ? (pt ? 'Está no lugar de sempre, no canto inferior direito.' : 'It is in its usual place, the bottom-right corner.')
            : (pt ? 'Você o moveu. Isto o devolve ao canto inferior direito.' : 'You moved it. This puts it back in the bottom-right corner.'),
          <SmallButton tap={tap} disabled={prefs.pos === null} onClick={() => setPrefs({ ...prefs, pos: null })}
            icon={<RotateCcw size={13} />} text={pt ? 'Voltar ao canto' : 'Back to the corner'} />,
          false,
        )}
      </Group>

      {/* ── NOTIFICATIONS ─────────────────────────────────────────────────────── */}
      <Group title={pt ? 'Notificações' : 'Notifications'}
        about={pt ? 'O cartão que sai do botão quando uma sessão precisa de você.' : 'The card that comes out of the button when a session needs you.'}>
        {choice(
          pt ? 'Como aparece' : 'How it appears',
          `${NAY_ANIMATION_HINT[notify.nayAnimation][lang]}.`,
          <Select value={notify.nayAnimation} onChange={v => saveNotify({ nayAnimation: v as NayAnimation })}
            options={NAY_ANIMATIONS.map(a => ({ value: a, label: NAY_ANIMATION_LABEL[a][lang] }))} />,
        )}
        {choice(
          pt ? 'O cartão acompanha com' : 'The card follows with',
          pt ? 'Como o cartão segue o botão se você o arrastar com o cartão aberto.' : 'How the card follows the button if you drag it while the card is open.',
          <Select value={prefs.cardStyle ?? INHERIT} onChange={v => setFollow('cardStyle', v)} options={[inheritOption, ...styleOptions]} />,
        )}
        {choice(
          pt ? 'Som' : 'Sound',
          pt ? 'Um som por tipo de aviso. O volume fica em Ajustes → Notificações.' : 'One sound per kind of notification. The volume is in Settings → Notifications.',
          <Switch on={notify.soundEnabled} label={pt ? 'Som dos avisos' : 'Notification sound'} tap={tap}
            onToggle={() => saveNotify({ soundEnabled: !notify.soundEnabled })} />,
          false,
        )}
        {notify.soundEnabled && CARD_EVENTS.map(ev => choice(
          ev[lang],
          `${pt ? ev.hintPt : ev.hintEn} ${soundAbout(notify.eventSounds[ev.key])}.`,
          <SoundPicker value={notify.eventSounds[ev.key]} options={soundOptions} tap={tap}
            playLabel={pt ? `Ouvir o som de "${ev.pt}"` : `Play the "${ev.en}" sound`}
            onPlay={() => playNotificationSound(notify.eventSounds[ev.key], notify.soundVolume)}
            onChange={v => {
              saveNotify({ eventSounds: { ...notify.eventSounds, [ev.key]: v as SoundPreset } })
              playNotificationSound(v as SoundPreset, notify.soundVolume)
            }} />,
        ))}
        {choice(
          pt ? 'Some sozinho após' : 'Goes away after',
          pt ? 'Fica enquanto você usa o cartão, e sempre fica na lista do botão.' : 'It stays while you use the card, and is always kept in the button’s list.',
          <Select value={String(notify.autoDismissSec)} onChange={v => saveNotify({ autoDismissSec: Number(v) })}
            options={AUTO_DISMISS_OPTIONS_SEC.map(n => ({ value: String(n), label: n === 0 ? (pt ? 'Nunca' : 'Never') : `${n} s` }))} />,
        )}
        {choice(
          pt ? 'Não perturbe' : 'Do not disturb',
          pt ? 'Sem cartão, sem som e sem impacto. Tudo continua no sino.' : 'No card, no sound, no impact. Everything is still in the bell.',
          <Switch on={notify.doNotDisturb} label={pt ? 'Não perturbe' : 'Do not disturb'} tap={tap}
            onToggle={() => saveNotify({ doNotDisturb: !notify.doNotDisturb })} />,
          false,
        )}
        <div style={{
          display: 'flex', alignItems: layout === 'rows' && !isMobile ? 'center' : 'stretch', gap: 10,
          flexDirection: layout === 'rows' && !isMobile ? 'row' : 'column',
          padding: 10, borderRadius: 9, background: 'var(--bg-elevated)', border: '1px dashed var(--border)',
        }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
            {pt
              ? 'Toca exatamente o que está escolhido acima: a entrada do cartão, o impacto no botão e o som de "Precisa de você".'
              : 'Plays exactly what is chosen above: the card’s entrance, the button’s impact and the "Needs you" sound.'}
            {notify.doNotDisturb && (
              <span style={{ color: 'var(--anthropic-orange-light)' }}>
                {pt ? ' Com o não perturbe ligado, um aviso de verdade não mostraria nada disso.' : ' With do-not-disturb on, a real notification would show none of it.'}
              </span>
            )}
          </div>
          <button type="button" onClick={() => previewNayNotification(lang)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0,
              minHeight: tap, padding: '0 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)',
              background: 'var(--anthropic-orange)', color: '#fff', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            <Sparkles size={14} />{pt ? 'Testar esta combinação' : 'Test this combination'}
          </button>
        </div>
      </Group>

      {/* ── NAY CONVERSATIONS ─────────────────────────────────────────────────── */}
      {conversations && (
        <Group title={pt ? 'Conversas da Nay' : 'Nay conversations'}
          about={pt ? 'Com o que toda conversa nova começa. Dá para trocar na hora de criar.' : 'What every new conversation starts with. You can change it when you create one.'}>
          {harnesses && defaults ? (
            harnesses.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Nenhum assistente pode ser iniciado nesta máquina.' : 'No assistant can be started on this machine.'}</div>
              : <NayLaunchFields layout={layout === 'rows' && !isMobile ? 'rows' : 'stack'} pt={pt} harnesses={harnesses}
                  value={normalizeChoice(defaults, harnesses)} onChange={saveNayDefaults} />
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Carregando os assistentes…' : 'Loading the assistants…'}</div>
          )}
          {choice(
            pt ? 'Som quando a Nay responde' : 'Sound when Nay replies',
            pt ? 'Toca quando chega uma resposta com o chat minimizado.' : 'Plays when a reply arrives while the chat is minimized.',
            <Switch on={chat.chatSoundEnabled} label={pt ? 'Som quando a Nay responde' : 'Sound when Nay replies'} tap={tap}
              onToggle={() => {
                const next = !chat.chatSoundEnabled
                chat.setChatSoundEnabled(next)
                putPreference({ chatSoundEnabled: next })
                if (next) playChat(chat.chatSoundId)
              }} />,
            false,
          )}
          {chat.chatSoundEnabled && choice(
            pt ? 'Qual som' : 'Which sound',
            pt ? 'Toque ▶ para ouvir antes de escolher.' : 'Press ▶ to hear it before choosing.',
            <SoundPicker value={chat.chatSoundId} tap={tap}
              options={CHAT_SOUNDS.map(s => ({ value: s.id, label: s.label[lang] }))}
              playLabel={pt ? 'Ouvir o som de resposta' : 'Play the reply sound'}
              onPlay={() => playChat(chat.chatSoundId)}
              onChange={v => { chat.setChatSoundId(v); putPreference({ chatSoundId: v }); playChat(v) }} />,
          )}
        </Group>
      )}
    </div>
  )
}

function Group({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  return (
    <section aria-label={title} style={{
      display: 'flex', flexDirection: 'column', gap: 12, padding: 12, borderRadius: 10,
      border: '1px solid var(--border)', background: 'var(--bg-surface)',
    }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{about}</div>
      </div>
      {children}
    </section>
  )
}

function Label({ text, hint }: { text: string; hint: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{text}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.4, marginTop: 1 }}>{hint}</div>
    </div>
  )
}

/**
 * One choice: its name, the line saying what it does, and the control. A WIDE control (a select)
 * goes under the text in `stack` and beside it in `rows`; a narrow one (a switch, a small button)
 * always sits beside it, where it is reached without scanning.
 */
function Choice({ label, hint, control, layout, wide }: { label: string; hint: string; control: ReactNode; layout: 'stack' | 'rows'; wide: boolean }) {
  const beside = !wide || layout === 'rows'
  return (
    <div style={{ display: 'flex', flexDirection: beside ? 'row' : 'column', alignItems: beside ? 'center' : 'stretch', gap: beside ? 12 : 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}><Label text={label} hint={hint} /></div>
      <div style={{ flexShrink: 0, ...(wide && beside ? { width: 240 } : {}) }}>{control}</div>
    </div>
  )
}

function SoundPicker({ value, options, onChange, onPlay, playLabel, tap }: {
  value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; onPlay: () => void; playLabel: string; tap: number
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}><Select value={value} onChange={onChange} options={options} /></div>
      <button type="button" onClick={onPlay} aria-label={playLabel} title={playLabel}
        style={{
          width: tap, height: tap, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--anthropic-orange)', cursor: 'pointer',
        }}>
        <Play size={14} fill="currentColor" />
      </button>
    </div>
  )
}

function SmallButton({ icon, text, onClick, disabled, tap }: { icon: ReactNode; text: string; onClick: () => void; disabled: boolean; tap: number }) {
  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, minHeight: tap, padding: '0 10px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'transparent', fontFamily: 'inherit', fontSize: 12, whiteSpace: 'nowrap',
    color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)', cursor: disabled ? 'default' : 'pointer',
  }
  return <button type="button" onClick={onClick} disabled={disabled} style={style}>{icon}{text}</button>
}

function Switch({ on, onToggle, label, tap }: { on: boolean; onToggle: () => void; label: string; tap: number }) {
  // The painted switch stays small; on touch the BUTTON around it is 44px tall and wide.
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle}
      style={{
        width: tap === 44 ? 52 : 40, height: tap, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', flexShrink: 0,
      }}>
      <span style={{ position: 'relative', width: 34, height: 19, borderRadius: 10, background: on ? 'var(--anthropic-orange)' : 'var(--border)', transition: 'background 120ms ease' }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: '50%',
          background: '#fff', transition: 'left 120ms ease',
        }} />
      </span>
    </button>
  )
}
