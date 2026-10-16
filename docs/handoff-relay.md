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
