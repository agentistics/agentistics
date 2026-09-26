# Provider credentials

The native runtime (Track B of the agentistics runtime; still BETA, off by default) needs your own
Anthropic API key to place a call. This page is `agentop provider key`: how the key gets in, where
it lives, what you can ask it, and how to take it back out.

- Design: [`docs/superpowers/specs/2026-09-25-runtime-b1-provider.md`](superpowers/specs/2026-09-25-runtime-b1-provider.md) §6
- Code: `packages/server/server/cli-provider.ts` (the verb) +
  `packages/server/server/provider/{credentials.ts,credential-plan.ts}` (storage + pure rules)

## The flag — `AGENTISTICS_PROVIDER`

The native runtime is opt-in. **Absent reads as OFF**, the same rule every other
`AGENTISTICS_*` switch in this product follows: with it unset, no provider module is loaded and no
credential file is read.

```
AGENTISTICS_PROVIDER=1 agentop provider key set anthropic
```

With the flag off, `key set` and `key remove` refuse in a sentence and touch nothing.
`key status` is the one exception — it always answers (see below), because "is this on" is itself
part of what status reports.

## The verb

```
agentop provider key set anthropic [--stdin] [--replace]
agentop provider key status [anthropic]
agentop provider key remove anthropic
```

**The key is never accepted on the command line, in any position.** A value on argv lands in shell
history and in `/proc/<pid>/cmdline`, readable by any process this user runs and by `ps` — the same
reason `agentop backup github setup` already asks for a GitHub token at a hidden prompt rather than
as an argument. Typing the key where the command expects the provider id, or as an extra word after
it, is refused in words and the refusal never repeats what you typed.

- **`agentop provider key set anthropic`** — a hidden prompt (nothing you type is echoed to the
  screen or written anywhere else). This is the default, and the one you want at a real terminal.
- **`--stdin`** — reads exactly one line from a pipe, for a scripted setup:
  ```
  pass show anthropic | agentop provider key set anthropic --stdin
  ```
  `echo sk-ant-… | agentop provider key set anthropic --stdin` still writes the key into your shell
  history — the pipe protects **argv**, not the command that feeds the pipe. Read the key from a
  secrets manager, a file with tight permissions, or type it at the hidden prompt instead of
  `echo`ing it.
- **`--replace`** — only meaningful with `--stdin`: a scripted rotation over an existing key is
  refused unless you pass it, since there is no terminal to ask "replace it?" on that path. At a
  real terminal, replacing an existing key always asks first (see Rotation, below), whether or not
  `--replace` was given.

Nobody should ever be asked to paste a key into a chat message, a GitHub issue, a task comment or a
file — including a prompt to an assistant implementing or reviewing this feature. If a key was ever
pasted somewhere it can be read back, revoke it in the Anthropic console and mint a new one; deleting
a local copy is not revocation (see Removal, below).

A Claude Pro/Max **subscription** cannot be used through this loop — it is not read, not detected,
and not silently substituted. This verb is for your own pay-as-you-go Anthropic API key, billed to
whichever console account issued it. Delegating a turn to the official `claude` CLI is the route for
a subscription.

## Storage

- **Path:** `~/.agentistics/provider-keys/anthropic.json` (one file per provider; `anthropic` is the
  only one B1 supports). Overridable with `AGENTISTICS_DIR`, the same variable that relocates every
  other agentistics data path — never `~/.claude`, which can be a container's read-only mount.
- **Modes:** the directory is `0700`, the file `0600`, both re-asserted with an explicit `chmod`
  after every write (a filesystem's own umask can otherwise widen either at creation time).
- **Atomic:** written to a uniquely-named temp file in the same directory, `fsync`ed, then renamed
  into place — a crash mid-write leaves the previous key intact, never a truncated one.
- **On read, a file whose mode carries any group/other bit is refused**, the same posture `ssh`
  takes toward a private key. `key status` reports this as its own state
  (`permissions-too-open`) with the fix spelled out:
  ```
  chmod 600 ~/.agentistics/provider-keys/anthropic.json
  ```
- **Not in `preferences.json`.** That file is served (redacted) over `GET /api/preferences`,
  written at the default file mode, carried whole into every backup, and read-modify-written by many
  modules — the opposite of "a few named holders" a credential needs. The provider key gets its own
  directory instead, exactly as the GitHub backup token and the sealed-envelope private key already
  do, for the same reasons.
- **Never read from the environment.** `ANTHROPIC_API_KEY` is not accepted as an implicit source —
  it already means something else on this machine (a signal `billing-detect.ts` reads to guess how
  *Claude Code* is billed) and an env var set in one launch context (a shell) but not another
  (a systemd user service) would make the same command behave differently with nothing on screen
  explaining why.

## `agentop provider key status`

Answers on every machine — with the flag off, with no key stored, on a central — rather than
refusing outright, because "is anything even configured" has to be answerable before anything is.
Per provider it prints:

- **state** — `present`, `absent`, `unreadable`, or `permissions-too-open` (with the `chmod 600`
  fix);
- **path** — where the file lives;
- **mode** — the file's permission bits;
- **stored** — when it was written (only once the file is actually read — see below);
- **fingerprint** — `sha256:xxxxxxxx`, the first 8 hex characters of the key's SHA-256.

**Decided: never a substring of the key.** Not the last 4 characters, not the prefix after
`sk-ant-`, not even its length. A suffix is literal key material — it narrows a brute force, it
turns up in every screenshot of this command's output, and it is indistinguishable from a genuine
leak to a test that greps for exactly that reason. The fingerprint is non-reversible, stable across
reads (so a rotation reads as `sha256:aaaa1111 → sha256:bbbb2222`), and is the same idiom this
product already uses for public keys. Its cost is real and stated rather than hidden: a hash cannot
be compared against whatever the Anthropic console itself shows (a masked form of the key, if
anything) — matching against the console is a possible future addition (tracked as an open item),
not something this page can promise today.

**With the flag off, the key file's content is never read at all** — only its presence, path and
mode are checked (a plain `stat`, never an `open`+`read`+hash) — so `status` can never produce a
fingerprint while the runtime that would use it is turned off.

## Rotation and removal

**Rotation** — running `set` again over an existing key:

- at a real terminal, you are shown the fingerprint already stored and asked to confirm before
  anything is overwritten. Declining leaves the old key exactly as it was.
- over `--stdin`, the same confirmation has no terminal to happen on, so it is refused unless you
  pass `--replace`.
- either way, a successful rotation prints `sha256:<old> → sha256:<new>`; a first-time `set` prints
  just the new fingerprint and the path it was written to. No history of old keys is kept.

**Removal** — `agentop provider key remove anthropic` deletes the local file (and the
`provider-keys/` directory itself, if that was the last key in it) and prints the fingerprint it
removed. **This is not revocation.** The key stays valid at Anthropic until you revoke it yourself,
in the console — agentop only ever holds a local copy, never the authority over it. Removing an
already-absent key is a no-op that says so and exits successfully; running `set` again afterwards
recreates exactly what `remove` deleted.

## Backups

A provider key is excluded from `agentop backup` as a `secret` — the same treatment the GitHub
backup token and every other live credential in this product get, because a *copy* of a live
credential inside a backup archive is a second place it can leak from, and restoring one onto a
different machine would let that machine spend against your account without you having typed
anything into it there.

Restoring a backup never restores the key. Re-enter it on the new machine instead:

```
agentop provider key set anthropic
```

## Centrals never hold one

A central aggregates many members' metrics; a provider key is one person's own billing credential
for the native runtime, which only ever runs locally (Track B's design keeps native execution off
the wire entirely — no member pushes a key, and no central stores one). `agentop provider key set`
and `agentop provider key remove` refuse outright on a central, with the reason stated in the same
sentence. `agentop provider key status` still answers there too, and says plainly that the machine
is a central.
