# Leader hand-off relay

A successor inherits the predecessor’s check-in agenda under its current session identity
(conversation id when available, otherwise managed id). When the harness later links its
conversation, both conversation-link paths move that agenda to the conversation id and update
its `session` field. The inherited agenda takes precedence over conversation defaults seeded
before the link finishes.

Before the kill path reads or sends a predecessor’s final relay, it persists
`handoffRelayClosing` on the registry row. Periodic relay passes skip that marker, including
when another process performs the kill. The marker remains after delivery or an owed-message
notice. The local in-flight guard also covers the late-send grace period. A content-bearing
relay advances its cursor only after confirmed delivery, including a successful late send.

An ended predecessor without the kill marker remains eligible inside the relay watch window:
crash recovery, restore and retirement can leave owner messages still owed to its successor.
Reopening a session preserves `handoffSeq`, `handoffFrom` and `handoffTo` so its generation and
links survive recovery. The kill marker belongs to the old row and is not inherited.

Relay delivery requires the explicit reciprocal `handoffTo` / `handoffFrom`
pair. `parentSessionId`, `parentConversationId` and the displayed `startedBy`
record only who opened a session; a live starter is never a predecessor on that
basis. Self-targets and continuations of the same conversation are rejected.
A real hand-off can forward while its predecessor finishes retiring. Injected
messages authored by the destination's managed or conversation identity are
excluded from the forward, preventing the sender from hearing its own message.

The web reuses Nay's open-session signal to report focus, visibility and whether
there was interaction since the previous heartbeat to
`POST /api/fleet/owner-presence`. Presence expires after 45 seconds without a
focused visible heartbeat. The server remembers the current session and last
interaction time in memory. Hidden or unfocused tabs release their presence.

A session explicitly awaiting a question/approval, or with a `needs_you`
check-in, starts a waiting episode. After five minutes, while the owner is
present in another session, the app shows “<title> está esperando você · Ir”.
This uses `NotificationToasts.tsx` and the existing notification store; it never
prompts a model. Only one notice is emitted per episode. Opening the waiting
session acknowledges the episode and clears its notice. Returning to ordinary
activity ends it. Presence and episode memory reset on server restart; the wait
is measured from the first observation, or the saved needs-you report time.

Live acceptance (delivery owner): in an isolated build, verify focus/blur and tab
visibility, two sessions with a five-minute wait, one notice only, its “Ir” link,
and clearing on open at desktop and 390px widths. Verify an ordinary child gets
no relay, a real hand-off still forwards, and a destination's own handback never
comes back through relay. This worker does not bind preview/server ports.
