import React, { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Check, HardDrive, FolderClock, ExternalLink, DatabaseZap } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import type { ArchiveMode } from '../../components/ArchiveConsentModal'
import { Divider, PrefRow, SectionHeader, Toggle } from './primitives'
import SessionPresetsSection from './SessionPresetsSection'

const ARCHIVE_DOCS_URL = 'https://code.claude.com/docs/en/settings'

export default function SessionsSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const [mode, setMode] = useState<ArchiveMode | null>(null)
  const [saving, setSaving] = useState<ArchiveMode | null>(null)
  const [savedAt, setSavedAt] = useState<number>(0)

  // The utility shell's own switch. `shellEnabled` is null until the preferences answer — a toggle
  // rendered from a guess would flick to its real position a moment later.
  const [shellEnabled, setShellEnabled] = useState<boolean | null>(null)
  const [shellSaving, setShellSaving] = useState(false)
  // The PROFILE's answer, which the switch may only ever narrow. Undefined on an older server that
  // had no capability model — read as permitted, the same reading the rest of the app uses.
  const shellCapable = ctx.capabilities?.localShell !== false
  // The disabled-shell empty state's "Enable now" button — a PER-PROCESS override, never written
  // to `preferences.json`. Read straight off `ctx`, never re-derived: it is the server's own
  // in-memory flag (`shell-override-store.ts`), and this screen has no other way to know it.
  const shellOverride = ctx.shellOverride === true

  // The Studio's own switch, shaped exactly like the shell's above and read the same way. It rides
  // the SAME capability — `sessions/editor-gate.ts` records why there is no separate `localEditor`
  // flag — but it is a SEPARATE preference: wanting a shell is not the same ask as wanting a
  // read/write file editor.
  //
  // THE USER-FACING NAME IS "STUDIO" ("Agentistics Studio" where a longer form reads naturally), and
  // this screen is the only place the feature can be turned on — so its copy is the one that must
  // not name a surface the reader will go looking for and not find. It said "the Repository tab"
  // long after the tab became a MODE that takes the whole aside. The internal names stay
  // repository-shaped on purpose (`repoApi.ts`, `/api/fleet/tree*`, `editorEnabled`): those describe
  // a repository, which is what they read.
  const [editorEnabled, setEditorEnabled] = useState<boolean | null>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  // A CENTRAL CAN NEVER RUN THE STUDIO, and this screen is the one place a user turns it on — so it
  // is the one place a false sentence about it is expensive. `CAPS.localShell` carries no central
  // term, so a central on a `local` profile reported "your profile allows this and you have it ON.
  // Each session gets the Studio in the side panel" over a deployment that refuses the whole
  // `/api/fleet` prefix — every request the Studio makes. It joins the capability rather than
  // becoming a fourth state: "this instance cannot do this, and nothing here can change that" is
  // exactly what the unavailable branch already means. Only the REASON differs, so only the reason
  // is worded apart — the three-way shape the shell's switch above keeps is untouched.
  const editorCentral = ctx.isCentral
  const editorCapable = ctx.capabilities?.localShell !== false && !editorCentral
  // Autosave is a CONVENIENCE, not a gate: no capability guards it, because it can only ever
  // narrow what `editorEnabled` already gates. It still has to reach the Studio without a
  // reload, so the change is MIRRORED into the app context — but the switch is RENDERED from this
  // page's own read, `boolean | null` exactly like `shellEnabled` above and for a sharper version of
  // the same reason. `ctx.editorAutosave` is a plain `boolean` that App seeds `false` and only
  // corrects when its own `/api/preferences` load lands — and it stays `false` through that load's
  // backoff retries. So with App's load failing while the fetch below answers `editorEnabled: true`,
  // the switch was ENABLED while drawing a guessed OFF, and one click wrote `true` over a stored
  // `true`: a user who had turned autosave off got it on, by opening this page and pressing the
  // control that claimed it was already off. Same pattern as `ChatSettings.tsx`.
  const [editorAutosave, setEditorAutosave] = useState<boolean | null>(null)
  const [autosaveSaving, setAutosaveSaving] = useState(false)

  useEffect(() => {
    fetch('/api/preferences')
      .then(r => (r.ok ? r.json() : null))
      .then((p: {
        archiveMode?: ArchiveMode; archiveSessions?: boolean
        shellEnabled?: boolean; editorEnabled?: boolean; editorAutosave?: boolean
      } | null) => {
        const m: ArchiveMode =
          p?.archiveMode ?? (p?.archiveSessions === true ? 'full' : p?.archiveSessions === false ? 'off' : 'off')
        setMode(m)
        // ABSENT READS AS ON when the profile is capable (owner decision, 2026-09-14) — only an
        // EXPLICIT `false` reads as off. `shellCapable`/`editorCapable` below are what actually
        // decide whether the toggle can be pressed at all; this is the preference's own value.
        setShellEnabled(p?.shellEnabled !== false)
        // Same reading for the Studio's switch, same reason.
        setEditorEnabled(p?.editorEnabled !== false)
        // Autosave is UNTOUCHED by the reversal above — it stays absent = OFF, since widening a
        // save race is a materially different risk than opening a panel that is already gated by
        // `capable` on the two switches above.
        setEditorAutosave(p?.editorAutosave === true)
      })
      .catch(() => {
        // A failed read is not a person answering "off" to either question — it is not knowing,
        // and each switch's own "absent" reading applies exactly as it would to a present-but-empty
        // preferences file. `archiveMode` keeps its own conservative 'off' default; unrelated.
        setMode('off'); setShellEnabled(true); setEditorEnabled(true); setEditorAutosave(false)
      })
  }, [])

  const toggleShell = () => {
    if (shellEnabled === null || !shellCapable || shellSaving) return
    const next = !shellEnabled
    setShellSaving(true)
    setShellEnabled(next)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shellEnabled: next }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed') })
      .catch(() => setShellEnabled(!next))  // put the switch back; nothing was saved
      .finally(() => setShellSaving(false))
  }

  const toggleEditor = () => {
    if (editorEnabled === null || !editorCapable || editorSaving) return
    const next = !editorEnabled
    setEditorSaving(true)
    setEditorEnabled(next)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editorEnabled: next }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed') })
      // `ctx.editorEnabled` is the SERVER's own resolved flag (`editorGate.ts`), never re-derived
      // here — so reaching every Studio entry without a reload means asking the server again, in
      // BOTH directions of this switch, rather than mirroring `next` into context as a guess.
      .then(() => ctx.refreshTeamSession?.())
      .catch(() => setEditorEnabled(!next))  // put the switch back; nothing was saved
      .finally(() => setEditorSaving(false))
  }

  const toggleAutosave = () => {
    // Meaningless while the editor itself is off, and while this page's own read has not landed:
    // flipping a value nobody has read yet writes a guess over whatever is stored.
    if (editorEnabled !== true || editorAutosave === null || autosaveSaving) return
    const next = !editorAutosave
    setAutosaveSaving(true)
    setEditorAutosave(next)
    ctx.setEditorAutosave(next)  // keeps the Studio in sync, no reload needed
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editorAutosave: next }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed') })
      .catch(() => {  // put the switch back, in both places; nothing was saved
        setEditorAutosave(!next)
        ctx.setEditorAutosave(!next)
      })
      .finally(() => setAutosaveSaving(false))
  }

  const choose = (m: ArchiveMode) => {
    if (m === mode || saving) return
    const prev = mode
    setMode(m)
    setSaving(m)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveMode: m }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed'); setSavedAt(Date.now()) })
      .catch(() => setMode(prev))
      .finally(() => setSaving(null))
  }

  const OPTIONS: { id: ArchiveMode; icon: React.ReactNode; title: string; desc: string; tag?: string }[] = [
    {
      id: 'consolidate',
      icon: <DatabaseZap size={18} />,
      title: pt ? 'Consolidar métricas' : 'Consolidate metrics',
      desc: pt
        ? 'Guarda as métricas calculadas de cada sessão (~KB). Preserva todos os números + agent metrics para sempre, sem duplicar arquivos.'
        : 'Stores each session’s computed metrics (~KB). Preserves all numbers + agent metrics forever, without duplicating files.',
      tag: pt ? 'Recomendado' : 'Recommended',
    },
    {
      id: 'full',
      icon: <HardDrive size={18} />,
      title: pt ? 'Cópia fiel completa' : 'Full faithful copy',
      desc: pt
        ? 'Espelha os transcripts crus também, para reler conversas antigas. Usa muito mais disco e cresce com o tempo.'
        : 'Also mirrors the raw transcripts so you can re-read old conversations. Uses much more disk and grows over time.',
    },
    {
      id: 'off',
      icon: <FolderClock size={18} />,
      title: pt ? 'Pasta padrão do Claude' : 'Claude’s default folder',
      desc: pt
        ? 'Não preserva nada. Sessões com mais de 30 dias continuam sumindo.'
        : 'Preserves nothing. Sessions older than 30 days keep disappearing.',
    },
  ]

  return (
    <div>
      {/* Presets are their own section, placed first: they are the most actionable thing on this
          page — a saved template to fire from the Sessions workspace — while the rest below is
          switches and a one-time preservation choice. */}
      <SessionPresetsSection />

      {/* THE SHELL SWITCH. A raw PTY on the host is strictly more powerful than the chat — which
          `chat-gate.ts` already calls the most powerful thing this server does, and the chat at
          least runs a NAMED assistant CLI — but the SECURITY model is entirely the exposure
          profile below, not this switch: it may only ever NARROW what the profile already permits,
          and the server enforces both before the routes rather than only here. Hiding a button
          would not close a door.

          ON BY DEFAULT on a capable profile (owner decision, 2026-09-14) — the bottom bar under
          every session's composer offers Claude Code, Shell and Studio as three standing entries of
          one control, and the owner's call is that Shell belongs there from the first run, the same
          way the session's own Claude Code pane always has. This switch is therefore an OPT-OUT,
          not an opt-in: turning it off is what a person does here, not turning it on. */}
      <SectionHeader label={pt ? 'Terminal nesta máquina' : 'Terminal on this machine'} />

      <PrefRow
        label={pt ? 'Habilitar o shell por sessão' : 'Enable the per-session shell'}
        sub={shellCapable
          ? (pt
            ? 'Ligado por padrão nesta instância. Abre um shell de verdade na pasta de uma sessão, direto no painel — desligue aqui se não quiser isso disponível.'
            : 'On by default on this instance. Opens a real shell in a session’s own folder, from the dashboard — turn it off here if you would rather not have that available.')
          : (pt
            ? 'Indisponível: o perfil de exposição desta instância não permite executar nada no host — o interruptor só pode restringir, nunca reabrir.'
            : 'Unavailable: this instance’s exposure profile does not allow running anything on the host — the switch can only narrow, never re-open.')}
      >
        <Toggle
          on={shellEnabled === true}
          onToggle={toggleShell}
          disabled={!shellCapable || shellEnabled === null || shellSaving}
        />
      </PrefRow>

      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {/* The sentence that distinguishes "your profile allows this, you have it off" from "your
            profile denies it" — the two are one disabled toggle apart and mean different things.
            A THIRD reading sits between them: the PERSISTED preference is off (this toggle stays
            off, and reflects exactly that — the permanent choice) while the "Enable now" button on
            the disabled-shell empty state has turned the shell on for the rest of THIS process. The
            toggle deliberately does not move for it — pressing it would write the persisted
            preference, not clear a memory the server itself forgets on restart — so this sentence is
            the only place that override is visible here. */}
        {!shellCapable
          ? (pt
            ? 'O perfil desta instância já nega o shell; nada aqui pode reabri-lo.'
            : 'This instance’s profile already denies the shell; nothing here can re-open it.')
          : shellEnabled
            ? (pt
              ? 'Seu perfil permite e você está com isso LIGADO (o padrão desta instância). Cada sessão ganha uma faixa "Shell" abaixo do compositor; no máximo 8 terminais abertos ao mesmo tempo.'
              : 'Your profile allows this and you have it ON (this instance’s default). Each session gets a "Shell" band below the composer; at most 8 terminals open at once.')
            : shellOverride
              ? (pt
                ? 'Você DESLIGOU isso, mas está ligado até reiniciar o servidor — alguém clicou "Habilitar agora" numa sessão. A preferência salva continua desligada; reiniciar o servidor volta a desligar de verdade.'
                : 'You have turned this OFF, but it is on until the server restarts — someone clicked "Enable now" on a session. The saved preference stays off; restarting the server turns it off for real.')
              : (pt
                ? 'Seu perfil permite isso, mas você DESLIGOU. Com o shell desligado, /api/shell/* responde 403 — o servidor é quem decide.'
                : 'Your profile allows this, but you have turned it OFF. With the shell off, /api/shell/* answers 403 — the server is what decides.')}
      </div>

      <Divider />

      {/* A PRODUCT NAME, so it is not localized — the same word in both languages. */}
      <SectionHeader label="Agentistics Studio" />

      <PrefRow
        label={pt ? 'Habilitar o Studio' : 'Enable the Studio'}
        sub={editorCapable
          ? (pt
            ? 'Ligado por padrão nesta instância. Dá a cada sessão um "Studio" na barra inferior: a árvore de arquivos e um editor de verdade — desligue aqui se não quiser isso disponível.'
            : 'On by default on this instance. Gives each session a "Studio" entry in the bottom bar: the file tree and a real editor — turn it off here if you would rather not have that available.')
          : editorCentral
            ? (pt
              ? 'Indisponível neste central: ele agrega métricas de outras máquinas e recusa /api/fleet/* por inteiro — não há arquivos daqui para abrir. Ligue o Studio na máquina onde a sessão roda.'
              : 'Unavailable on a central: it aggregates other machines’ metrics and refuses the whole of /api/fleet/* — there are no files here to open. Turn the Studio on over on the machine the session runs on.')
            : (pt
              ? 'Indisponível: o perfil de exposição desta instância não permite ler nem escrever arquivos do host — o interruptor só pode restringir, nunca reabrir.'
              : 'Unavailable: this instance’s exposure profile does not allow reading or writing host files — the switch can only narrow, never re-open.')}
      >
        <Toggle
          on={editorEnabled === true}
          onToggle={toggleEditor}
          disabled={!editorCapable || editorEnabled === null || editorSaving}
        />
      </PrefRow>

      <PrefRow
        label={pt ? 'Salvar automaticamente' : 'Autosave'}
        sub={pt
          ? 'Desligado por padrão. Ligar salva sozinho ~1–2s depois da última tecla — o custo é uma janela maior pra colidir com uma escrita do agente no mesmo arquivo.'
          : 'Off by default. Turning it on saves on its own ~1–2s after the last keystroke — the cost is a wider window to collide with an agent’s own write to the same file.'}
      >
        <Toggle
          on={editorAutosave === true}
          onToggle={toggleAutosave}
          disabled={editorEnabled !== true || editorAutosave === null || autosaveSaving}
        />
      </PrefRow>

      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {/* The same three-way sentence the shell's switch carries above, and for the same reason:
            "your profile denies this" and "your profile allows it, you have it off" are one
            disabled toggle apart and mean different things. */}
        {!editorCapable
          ? editorCentral
            ? (pt
              ? 'Este central recusa /api/fleet/* por inteiro, então o Studio não tem o que abrir aqui — o interruptor está inerte nesta tela, e nem o botão aparece. É uma configuração de máquina, não de central.'
              : 'This central refuses the whole of /api/fleet/*, so the Studio has nothing to open here — the switch is inert on this screen, and not even the button appears. It is a machine’s setting rather than a central’s.')
            : (pt
              ? 'O perfil desta instância já nega o acesso a arquivos do host; nada aqui pode reabri-lo.'
              : 'This instance’s profile already denies host file access; nothing here can re-open it.')
          : editorEnabled
            ? (pt
              ? 'Seu perfil permite e você está com isso LIGADO (o padrão desta instância). Cada sessão ganha o Studio na barra inferior, com leitura e escrita na pasta da própria sessão.'
              : 'Your profile allows this and you have it ON (this instance’s default). Each session gets the Studio in the bottom bar, reading and writing inside that session’s own folder.')
            : (pt
              ? 'Seu perfil permite isso, mas você DESLIGOU. Com o Studio desligado nem a entrada aparece, e /api/fleet/tree* responde 403 — o servidor é quem decide.'
              : 'Your profile allows this, but you have turned it OFF. With the Studio off not even the entry appears, and /api/fleet/tree* answers 403 — the server is what decides.')}
      </div>

      <Divider />

      <SectionHeader label={pt ? 'Preservação de histórico' : 'History preservation'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'O Claude Code apaga transcripts com mais de 30 dias a cada inicialização. Escolha como o Agentistics preserva seu histórico (tudo fica local em ~/.agentistics).'
          : 'Claude Code deletes transcripts older than 30 days on every startup. Choose how Agentistics preserves your history (everything stays local in ~/.agentistics).'}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {OPTIONS.map(opt => {
          const active = mode === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => choose(opt.id)}
              disabled={saving !== null}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 11, textAlign: 'left',
                padding: '13px 15px', borderRadius: 'var(--radius-lg)',
                border: active ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
                background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                cursor: saving !== null ? 'default' : 'pointer',
                fontFamily: 'inherit',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <span style={{ color: active ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', flexShrink: 0, marginTop: 1 }}>
                {opt.icon}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.title}</span>
                  {opt.tag && (
                    <span style={{
                      fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                      color: 'var(--accent-green)', border: '1px solid var(--accent-green)',
                      padding: '1px 6px', borderRadius: 10,
                    }}>{opt.tag}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>{opt.desc}</div>
              </div>
              {active && <Check size={16} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, marginTop: 2 }} />}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <a
          href={ARCHIVE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--anthropic-orange)', textDecoration: 'none' }}
        >
          <ExternalLink size={13} />
          {pt ? 'Documentação oficial' : 'Official documentation'}
        </a>
        {savedAt > 0 && saving === null && (
          <span style={{ fontSize: 11.5, color: 'var(--accent-green)' }}>{pt ? 'Salvo' : 'Saved'}</span>
        )}
      </div>
    </div>
  )
}
