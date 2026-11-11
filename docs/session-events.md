# The event channel — `agentop events`

Whoever fans five sessions out with [`agentop session batch`](session-manager.md#orchestrating-several-at-once)
is blind between the moment they start and the moment they look. A session that finished, exited, or
stopped on a permission prompt says so on its own screen, in a pane nobody is attached to.

`agentop events` turns a state CHANGE into something that reaches you: an append-only inbox on disk,
a message into another Claude Code session, and a notification on your desktop.

```bash
agentop events watch --task "auth-refactor" --notify cockpit --desktop
agentop events status
agentop events tail --since 8140:37 --json
agentop events unwatch s1
```

---

## The boundary, first

Everything below is built so that this holds:

- **An event informs.** It records when, which session, which task, from what state to what state,
  and the last few lines that were on screen. It carries no instruction, no suggestion, no request.
  `SessionEvent` has no field that could hold one, and a subscription has no field naming something
  to run.
- **Approval is never automatic.** A session blocked on a permission prompt is reported as
  *"is waiting on a permission prompt — that prompt is for a person to answer"*, and that is the
  whole of it. Nothing in this channel can answer such a prompt, and every message it sends carries
  a standing note saying so.
- **What travels is yours.** A screen tail can contain anything you typed. It is written to
  `~/.agentistics/events.jsonl` with mode `0600` and does not leave the machine — not to another machine,
  not anywhere.

`events-frontier.test.ts` asserts all three, including by reading the modules' own source: a field
called `action` or a notification sentence in the imperative fails the build.

---

## Two sources, and they are not equivalent

| | how it knows | covers | latency |
|---|---|---|---|
| **poll** | reads the SCREEN through `attention.ts` | every harness agentop manages | up to ~5 s |
| **hook** | Claude Code's `Stop` event fires | Claude only | immediate |

The **poll is the floor**. It works for codex, gemini, copilot, kimi and antigravity, none of which
have a hook to offer, and it is the only thing that can see a permission prompt at all — Claude Code
does not fire `Stop` for one.

The **hook is exact**. `agentop hooks install` registers `Stop → agentop events emit`, which writes
one line and exits. No polling, no inference, no five-second wait.

Both report the same end of a Claude turn, so `event-dedupe.ts` drops the poll's copy when a hook
event for the same conversation landed within twenty seconds. The rule is one-directional — the
hook's exact record always survives — and `waiting-approval` is never deduped, because it has no
hook counterpart and is the event nobody may lose.

---

## Why the producer is a daemon and not a command

The fleet monitor holds two things between polls: each session's last frame digest, and each
session's last state. Both are what make the answer correct, and neither survives a process that
starts and exits:

- **Movement is the only universal proof of work.** Several harnesses draw an identical screen while
  streaming output and while sitting idle — codex's footer and ghost placeholder are byte-identical
  either way. The only evidence a session is working is that the frame CHANGED since last time, and
  a single-invocation poll has no last time.
- **tmux's own activity timestamp cannot fill the gap.** Measured on a live machine: a session that
  had been working continuously for 53 minutes reported its last tmux activity 3185 seconds earlier,
  because nothing was attached to it.

So a cron job or a per-invocation check would announce that five sessions had finished at the moment
they all started. False notifications are worse than none — people stop looking.

The producer therefore lives inside the daemon that `agentop server` already starts
(`otel-watcher`), which is also what `agentop autostart` already covers. `agentop events run` starts
the same producer in the foreground for someone who does not run the server, and `agentop events
status` reports the producer as **running**, **stale** (its process is gone) or **absent** — because
"nothing arrived" must be distinguishable from "nothing was watching".

Set `AGENTISTICS_EVENTS=0` to keep the daemon from watching sessions at all.

---

## A state that lasted one frame is not a state

The first version of this channel reported the same session as `waiting` twice, ten seconds apart.
Nothing had happened: its pane repainted — a tmux advisory line appeared at the bottom — and a frame
that MOVED is correctly read as `working`, so the next frame was correctly read as `waiting` again.
It happened again forty-five seconds later when a plugin printed a notice into the same pane.

A time window does not fix it. The first attempt was one, and the second flicker landed outside it;
any window wide enough to catch a repaint also swallows a genuine follow-up turn, which is the
primary thing this channel exists to report.

So the rule uses the signal itself: **a state counts only once it has been observed on two
consecutive polls**, and events are compared against the last CONFIRMED state. A repaint is one
frame and is never confirmed. What it costs, stated plainly: a turn that begins and ends inside a
single five-second interval is invisible to the poll source — which is precisely the case the
`Stop` hook covers exactly, and a large part of why the hook exists.

This is deliberately not a change to `attention.ts`. "The screen moved, so it is working" is the
right rule for the cockpit and the only signal several harnesses give.

---

## The inbox

`~/.agentistics/events.jsonl`, append-only JSONL, one event per line.

It is not a cache. **A Claude session only exists while it is being invoked**, so an event delivered
to a session that is parked happened to nobody. The inbox is what makes the channel work for the
consumer that is not running: it reads what happened since it last looked, on its own schedule. The
socket and the toast make that read happen *sooner*; they never replace it.

- **Cursors are a pair, `offset:seq`.** A byte offset alone is exactly what rotation invalidates.
  `agentop events tail --json` prints the cursor; `--since` takes it back. A cursor from before a
  rotation reads from the start of the current file and says `rotated: true` rather than returning
  nothing.
- **It rotates at 2 MiB**, keeping exactly one previous generation as `events.jsonl.1`.
- **An unreadable line costs that line.** A file written by a newer agentop, or truncated by a
  crash, still reads — and `tail` / `status` report how many lines this version could not read
  rather than silently showing an empty inbox.

---

## Delivering to another Claude session

`--notify <name|pid>` names a Claude Code session. Claude Code registers each one as
`~/.claude/sessions/<pid>.json` with a `messagingSocketPath`, and agentop delivers over that socket.

Two things make it safe rather than merely working:

- **The registry says who exists; the socket says who is UP.** Measured on one machine: 79 records,
  five live sockets. A record is deliverable only when the socket it names is present.
- **The message carries the target's own `session_id`**, which the receiver checks against its own.
  Pid files outlive their processes and pids get reused; without it a stale record could deliver a
  fleet event into an unrelated conversation.

A session that is not up is **not** delivered to, and the command says so. The event stays in the
inbox and that session reads it with `agentop events tail` when it next runs. There is no path here
that reports a success it did not observe.

The socket protocol is Claude Code's own and is not a published API. Every failure is reported as a
failure — a broken socket costs latency, not the event.

---

## Delivering to you

`--desktop` uses the first channel this machine actually has, in this order:

1. **`claude-code-notifications`** (the `ccn` Claude Code plugin), when it is installed *and* its own
   requirements (`jq`, `powershell.exe`) are present. On WSL it already solves the hard half — a real
   Windows toast, a sound, and a click that focuses the session's window.
2. **`notify-send`** — the Linux desktop standard, absent on WSL, which is why it is not first.
3. **`powershell.exe`** — a plain Windows toast from WSL, no sound and no click target.
4. **the terminal bell**, when there is a terminal.
5. **nothing** — and `status` says so in a sentence naming everything it looked for.

ccn is **detected, never embedded**. It ships through the Claude Code plugin system with its own
release cycle while agentop is one compiled binary, so a bundled copy would be a second version to
drift. What agentop sends it is the payload shape it already accepts — a Claude Code `Notification`
hook envelope with a `message` and a `cwd` — so agentop contributes the five harnesses ccn cannot
see and the task grouping neither tool has alone, without either knowing the other's internals.

`agentop events test` delivers a probe through the real channels, so a broken one is found before
you have spent a week trusting it. The probe is deliberately **not** written to the inbox: a test
event among real ones is a fact that never happened.

Set `AGENTISTICS_EVENTS_DESKTOP=0` to switch the desktop step off; `status` reports that as its own
reason, distinct from "unavailable".

---

## Subscriptions are a file, not a process

`agentop events watch` writes a row to `~/.agentistics/event-subscriptions.json`. Whichever producer
is up delivers it. This is the point: a foreground command you must remember to start is a command
that will not be running at the moment it matters, and a subscription in a file survives a reboot.

```
--task <name>      only sessions filed under that task (EXACT — "api" must not select "api-migration")
--session <ref>    only that session, by agentop id prefix or by label
--on <states>      working, waiting, waiting-approval, exited, turn-end
                   (default: waiting, waiting-approval, exited)
--notify <ref>     a Claude Code session to inform
--desktop          a notification for you
```

A subscription with no delivery is legal and useful: it still shapes what the producer RECORDS, and
`agentop events tail` reads that. `status` describes it as "inbox only" rather than as nothing.

`watch` refuses a `--notify` naming a session nobody has registered, and prints the sessions that
are running — a subscription that can never deliver is one you believe is working. A session that is
merely not up right now is accepted and said out loud.

---

## Command reference

```
agentop events watch   [--task <name>] [--session <id|label>] [--on <states>]
                       [--notify <claude-session>] [--desktop] [--note <text>] [--json]
agentop events unwatch <id> | --all
agentop events status  [--json]
agentop events tail    [-n <count>] [--since <offset:seq>] [--task <name>] [--on <states>]
                       [--follow] [--json]
agentop events run     [--once]
agentop events test    [--notify <claude-session>] [--desktop]
```

`--once` seeds and says so: one tick can only record where everything IS, because a transition needs
a second look.

It is `agentop events`, not `agentop watch`, because `agentop watch` is already the OpenTelemetry
metrics daemon — taking that verb would make `agentop restart watch` ambiguous and silently retarget
a name people have in scripts.

---

## Where each piece lives

| module | what it decides |
|---|---|
| `events/event-types.ts` | the shape of an event, and what it may not carry |
| `events/event-plan.ts` | **pure** — which transitions are events; the two-poll confirmation rule |
| `events/event-line.ts` | **pure** — one event ↔ one line; tolerating a line this version cannot read |
| `events/event-rotate.ts` | **pure** — the cap, and the cursor that survives a rotation |
| `events/event-dedupe.ts` | **pure** — the same turn seen by both sources, read once |
| `events/subscriptions.ts` | **pure** — who hears what |
| `events/events-parse.ts` | **pure** — `agentop events …` |
| `events/notify-text.ts` | **pure** — what a notification is allowed to say |
| `events/notify-plan.ts` | **pure** — which desktop channel this machine has, and why |
| `events/peer-target.ts` | **pure** — which Claude session a `--notify` names, and whether it is up |
| `events/event-store.ts` | the inbox on disk |
| `events/peer-client.ts` | the socket |
| `events/desktop.ts` | the probe and the spawn |
| `events/notifier.ts` | one batch, delivered |
| `events/producer.ts` | the long-lived poller |
| `events/daemon.ts` | it riding along with `otel-watcher` |
| `cli-events.ts` | the command |

See also [docs/claude-integration.md](claude-integration.md) for the `Stop` hook half and
[docs/session-manager.md](session-manager.md) for the fleet it watches.
