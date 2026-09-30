# Session notifications from the Nay button

When a session needs a person, the floating Nay button **speaks**: a card comes out of it saying
which session, on which assistant and model, how long it has been waiting and when its last message
came, with the actions to deal with it right there. It replaces the operating system's notification
while the tab is visible. Design chosen by the owner on 2026-09-29 from the artifact
`https://claude.ai/artifact/8V43JVxdr5KWwws34XkK1x`.

## When a card appears

| Event | Card | Default sound |
|---|---|---|
| A session finished its turn and waits (`waiting`) | "Ei, a sessão respondeu." | Kalimba |
| A session is stopped on a dialog (`waiting-approval`) | "Ei, olha essa sessão: ela pediu permissão." | Pergunta |
| A waiting session nobody opened for the chosen time (default 1 h) | "Ei, essa sessão está parada faz tempo." | Brisa |

The transitions come from the fleet poll's existing rule (`notifyFleetTransitions`: a state counts
only after two consecutive polls, the first snapshot announces nothing). "Not opened" is measured
from the later of when the session started waiting and when this browser last opened it, and fires
once per waiting episode.

A card about the session already open on screen is never shown. A card whose session was answered
somewhere else disappears on the next poll.

When a session replies (`waiting`) and the page is **not** `/sessions`, the button also plays the
**shock** (squash plus two rings) the owner chose for it.

## Actions

- **Responder** — the fleet's own `prompt` verb. The server refuses it in words while a dialog is open.
- **Ir para a sessão** — navigates to `/sessions/<id>`.
- **Aprovar…** — approval cards only. It lists the options the server read off the session's screen
  (`dialogOptions`) and sends the one tapped, by number. When the options cannot be read it says so
  and sends nothing. A notification never approves anything by itself.
- **Adiar** — 15 min, 1 h, or "Inserir tempo" (`30m`, `2h`, `1h30`, `1,5h`; 1 min to 24 h,
  validated by `parseSnooze`). A snoozed card comes back when its time runs out, if what it said is
  still true. Snoozes are kept per browser (`localStorage`) so a reload does not lose them.
- **Encerrar** — stale cards only (`NayEndSession.tsx`). Never a blind kill:
  - already in a folder: says it stays there, offers **Encerrar** and **Encerrar e fixar**;
  - in no folder: suggests one by the idle-review rule (`defaultGroupFor`), and offers
    **Encerrar e guardar em …**, **Escolher pasta…** (the Agentistics `Select`), **Criar pasta e
    guardar**, **Só encerrar** and **Encerrar e fixar**.

  Every path then shows `StopSessionConfirm`, the session's own End confirmation. Filing goes through
  `/api/session-groups` (`planGroupOp`'s move rule) and pinning through `pinnedSessions.ts`, both
  BEFORE the kill, which runs only if they worked.
- **×** — dismiss.

## Delivery rules (`sessionNotifications.ts` → `deliver`)

- Every event is written to the **bell** (`lib/notifications.ts`, codes `session.turn_ended`,
  `session.needs_approval`, `session.stale`, `session.working`, `session.exited`). Its `meta` is the
  same in every tab (the minute, not the millisecond), so the server's dedupe keeps one row. The
  generic toast skips the three card codes, since the card shows them.
- **Tab visible** → the card and the event's sound.
- **Tab in the background** → the system notification, since a card there would go unseen (switch:
  "Notificação do sistema com a aba em segundo plano").
- **Não perturbe** → no card, sound, shock or system notification. The bell still records everything.
- **Movimento reduzido** → every entrance becomes a fade and the shock a brief tint.

## Settings

- **Animation** (`launch` default, `balloon`, `unfurl`, `voice`): the dock's gear popover and
  Settings → Chat, both with the Agentistics `Select`, one stored value
  (`NotificationSettings.nayAnimation`).
- **Sounds**: Settings → Notificações, one per event, from the four original chimes plus the 13
  synthesized in `lib/notificationSounds.ts` (Web Audio, no audio files, no licence).
- **Stale threshold**: 15 min, 30 min, 1 h, 2 h, 4 h or never.
- **Do not disturb**: the gear popover and Settings → Notificações.
- **Test**: "Testar Som e Notificação" pops a DEMO card that names no session, so only snooze and
  dismiss work on it.

## Modules

| File | Role |
|---|---|
| `lib/nayNotify.ts` | PURE rules: snooze parsing, stale decision, waiting text, card placement, animation ids |
| `lib/nayNotifyStore.ts` | the queue, the waiting clocks, last-opened stamps, snoozes |
| `lib/nayNotifyAnim.ts` | the four entrances, the exit into the button, the shock (Web Animations API) |
| `lib/notificationSounds.ts` | the 13 synthesized sounds |
| `components/nay/NayNotifyCard.tsx` | the card, mounted by `NayDock` |
| `components/nay/NayEndSession.tsx` | the "Encerrar" choice |
