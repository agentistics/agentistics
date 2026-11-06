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

Switching to another harness transfers every child to the successor, including ended children
so a later reopen keeps the correct parent. Both the managed parent id and its conversation id
are updated; when the successor has no linked conversation yet, the old conversation id is
cleared. A worker that switches keeps its own parent and role. The transfer happens after the
successor is confirmed running, before ending the predecessor; a failed launch leaves the team
with the original session.

Session messages follow the registry's successor chain (including reopened successors). Workers
can report using the old parent's managed or conversation id from their existing briefing even
after that parent disappears from the fleet. Delivery, board comments, handback events and rate
limits use the resolved successor. The normal self-message guard still applies after resolution.
