# agentistics CLI — `agentop`

`agentop` is the single binary for everything agentistics does: run the dashboard,
the terminal TUI, the OpenTelemetry daemon,
and manage autostart + updates.

Get the binary from the [install instructions](../README.md#install) (`install.sh`,
`npm i -g @agentistics/agentop`, the Windows installer, or `bun run build:binary` from
source). The one-liner `curl -fsSL https://agentop.openvibes.tech/cli | sh` works with
`sh`, `bash` or `zsh`; unprivileged installs go to `~/.local/bin` and the PATH line is added
to your login shell's rc file (idempotent). The installer then offers to start agentistics now and on login/boot (Enter = yes; `AGENTOP_INSTALL_START` / `AGENTOP_INSTALL_AUTOSTART` = `yes|no` skip the questions; no terminal = nothing started). `agentop setup --defaults` applies the recommended first-run settings (archive mode `consolidate`) non-interactively, never overriding an existing choice. From a checkout you can also run it directly with
`bun run packages/server/bin/cli.ts <command>`.

```bash
agentop --help       # full usage
agentop --version    # print version (and a notice if an update exists)
```

> **Ports:** an instance serves the **web dashboard on 47292** (the URL you open) and
> the **api + mcp on 47291** (in dev, Vite serves the web on 47292 and the api runs on 47291 — same split).

---

## Command overview

| Command | Purpose |
|---------|---------|
| [`start`](#start) | The control center — services, setup, logs, commands, help (same as bare `agentop`) |
| [`setup`](#setup) | Interactive first-run wizard (history consent, start on boot) |
| [`server`](#server) | Start the web dashboard + api + Nay + background daemon (non-interactive) |
| [`restart`](#restart) | Restart a running mode so it picks up new code / config |
| [`status`](#status) | At-a-glance: mode, services (server/machine) + health |
| [`tui`](#tui) | Live terminal dashboard (no browser) |
| [`watch`](#watch) | OpenTelemetry metrics daemon only (headless) |
| [`session`](#session) | Start / list / attach / kill background assistant sessions (tmux-backed); `ls` prints the cockpit's table |
| [`run`](#run) | Execute a command with a disposable home and separate API/web ports |
| [`hooks`](#hooks) | Teach Claude Code to fan work out across several assistants through agentop |
| [`backup`](#backup) | Back up this machine's history — metrics, and a manifest that rebuilds every repository |
| [`restore`](#restore) | Restore a backup, or pull one from the private GitHub repository holding them |
| [`autostart`](#autostart) | Start a mode with the system (systemd user service) |
| [`upgrade`](#upgrade) | Upgrade `agentop` to the latest release |
| [`uninstall`](#uninstall) | Remove `agentop` — service, shell hook, binary; your data is asked about separately |
| [`check-update`](#check-update) | Print an "update available" banner, else stay silent |
| [`doctor`](#doctor) | Run the exposure preflight before exposing an instance |

Running **bare `agentop`** on an interactive terminal opens the
[control center](#start). Without a terminal it prints this help; `--help` always prints it.

---

## `run`

```bash
agentop run --rm -- bun --version
agentop run --rm -- bun test packages/server/server/cli-run.test.ts
agentop run ls
agentop run stop <name>
```

Each run gets a disposable `HOME`, `USERPROFILE`, Agentistics data directory, temporary
directory, and reserved API/web ports. Its home and port reservations are removed when it exits.
The command inherits `PATH`. An explicit `VOLTA_HOME` is preserved; otherwise, when the original
home contains `.volta`, that installation is pinned in `VOLTA_HOME` before changing `HOME`.
This lets Volta's bun/node/npm shims find their installed toolchains without repeatedly invoking
themselves through `PATH`.

Every run also drops the variables that move a harness's config away from the run's own `HOME`
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME`, `OPENCODE_*`, `KIMI_*_HOME`,
`AGENTISTICS_DATA_DIR`, `AGENTISTICS_FLOWS`) and points `XDG_*_HOME` inside the run's home, and it
removes any `structured/` directory from the run's store before starting (live relays belong to the
real store only).

### `run --serve` (disposable ambiente)

```bash
agentop run --rm --serve --name amb-x [--seed-from <staging>] [--cwd <worktree>] [--ttl 2h] [-- <server command>]
```

A long-lived server. Unlike `run --rm -- <cmd>` it is **never** wrapped in `agentop heavy`, and it
refuses to start (exit 4) from inside a heavy job or with the heavy lock inherited as a descriptor.
`--cwd` accepts only a linked git worktree. `--seed-from` accepts only a staged seed under
`<dataDir>/flows/ambientes/<id>/semente/`; only an allow list of the real store (`journal.db`,
`cache.db`, `git-stats.db`, `index/`, `content/`, `archive/` …) is ever copied, never sessions,
accounts, the vault or `structured/`. The flows `ambiente-subir` / `ambiente-descer` drive this.

## `start`

The **control center** — one full-screen application, in the terminal's *alternate buffer*, so it
adds nothing to your scrollback no matter how long you use it. Bare `agentop` opens the same thing.

```bash
agentop                      # the usual way in
agentop start
agentop start --lang pt      # force Portuguese for this run
```

```
 ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █ █▀ ▀█▀ █ █▀▀ █▀
 █▀█ █▄█ ██▄ █░▀█ ░█░ █ ▄█ ░█░ █ █▄▄ ▄█                           solo · v1.7.3 · ● 1.7.4

  services   setup   logs   commands   help   contribute
 ━━━━━━━━━━
 ╭─ services ─────────────────────────────╮╭─ config ─────────────────────────────────────╮
 │ ❯ agentistics         native ● up      ││   mode     solo                              │
 │   agentistics docker         ○ stopped ││   endpoint http://localhost:47292            │
 │                                        ││   history  consolidate                       │
 │                                        ││   language English                           │
 ╰────────────────────────────────────────╯╰──────────────────────────────────────────────╯
 ╭─ agentistics ────────────────────────────────────────────────────────────────── native ╮
 │ native · pid 48213 · up 2h13m                                                          │
 │                                                                                        │
 │ RUNTIMES ───────────────────────────────────────────────────────────────────────────── │
 │ native   ● up · pid 48213 · up 2h13m                                                   │
 │ docker   ○ stopped                                                                     │
 │                                                                                        │
 │ ADDRESSES ──────────────────────────────────────────────────────────────────────────── │
 │ web      http://localhost:47292                                                        │
 │ api      http://localhost:47291                                                        │
 │                                                                                        │
 │ MACHINE ────────────────────────────────────────────────────────────────────────────── │
 │ boot     starts at boot                                                                │
 │ history  consolidate                                                                   │
 │ endpoint http://198.51.100.199:48080                                                   │
 │   Restart   Rebuild & restart   Stop   Open in browser                                 │
 ╰────────────────────────────────────────────────────────────────────────────────────────╯

 q quit  ·  ←→ screens  ·  tab pane  ·  ↑↓ move  ·  enter actions  ·  s stop  ·  R restart
```

### The screens

Move between them with **`←` / `→`** — there are no digit shortcuts for screens, so the digits
always belong to whatever list is drawing them.

| Screen | What it is for |
|---|---|
| **services** | The cockpit: start / stop / restart, enable a boot service |
| **setup** | The same wizard as [`setup`](#setup): the history-preservation consent |
| **logs** | A tailing viewer, one source per running service |
| **commands** | The cheat sheet — every command, without leaving the app |
| **help** · **contribute** | What the keys do, and how to contribute |

### The services screen

The services list is the **selection**; the pane below is a view *of* it, so moving the cursor
repaints it. `tab` cycles the panes (services → config → actions) and the actions are
**focus-scoped**: with a service selected they act on *that* service, which is why there is no
"stop which?" submenu.

- **One row per logical service, never per runtime.** `agentistics` run natively and the same
  program in a container are two *runtimes* of one service. A running service therefore offers no
  "start" at all — it offers **Restart**, **Rebuild & restart** (only where a rebuild could actually
  work here), **Stop** and **Open in browser**. A stopped one is dimmed and offers only the starts
  this machine can perform.
- **A service running under BOTH runtimes says so**, in colour, with a word — and its verbs split
  into `Stop (native)` / `Stop (docker)`. They read the same files and fight over the same port, so
  the conflict is never normalised away by showing just one.
- **A long action streams into the detail pane**, titled with the verb you pressed, while the lists
  stay standing beside it. `esc` puts the facts back.
- The **Docker** option mounts the host's harness dirs read-only — run the machine in Docker **or**
  natively, not both.

The footer always names the keys that work *in the current focus*; it is the only documentation the
screen has, so a hint for a key that does nothing there is a bug.

**Non-interactive stdin** (a pipe, a systemd unit) skips all of this and behaves exactly like
[`server`](#server). `q` leaves without starting anything.

---

## `restart`

Restart a running mode so it picks up new code (after an `upgrade` / `git pull`) or a changed
config. Defaults to `server`.

```bash
agentop restart                      # = restart server
agentop restart server               # bounce the systemd user service (agentop-server)
agentop restart watch                # bounce the watch service
agentop restart --all                # bounce every service currently up
agentop restart --rebuild            # rebuild first, then restart
agentop restart --rebuild --cache    # …reusing the layer cache
```

`server`/`watch` bounce the installed [systemd user service](#autostart) — if none is installed it
tells you to run it in the foreground or enable autostart first. `--all` bounces everything that is
up (local + machine), non-interactively.

**`--rebuild` is a FULL rebuild.** The Docker paths pass `--no-cache`, because a cached build can
hand you back the very image it was asked to replace — which is the one failure mode a rebuild
exists to prevent. That takes several minutes, and the command says so on the way in:

| Flag | Effect |
|---|---|
| `--cache` | Reuse Docker's layer cache instead — the fast path |
| `--no-cache` | The default for a rebuild; stated explicitly |

Passing `--cache` with `--no-cache` is **refused**, not silently resolved.

---

## `status`

Non-interactive, at-a-glance report of this machine. Prints three blocks:

- **CONFIG** — the mode and the history-preservation setting (from preferences).
- **SERVICES** — detected live: the local server (`http://localhost:47291/api/health`;
  shows the dashboard URL when up), and the machine container.
- **HEALTH** — a one-line summary from `/api/health` when the server is up, else `n/a`.

```bash
agentop status
```

Handy for a quick "is everything up and healthy?" without opening the dashboard.

---

## `setup`

Interactive first-run wizard. Asks the history-preservation consent and then offers to
enable [autostart](#autostart).

```bash
agentop setup
```

Needs a TTY. Ctrl-C is non-destructive — it aborts without touching your
preferences. `agentop setup --defaults` applies the recommended settings non-interactively.

---

## `server`

Starts the web dashboard, api, Nay chat, MCP registration, and the OTel daemon —
everything in one process. Binds two ports: the **web dashboard on 47292** (open this) and the
**api + mcp on 47291**. They share one request handler, so the dashboard's `/api/*` calls just work.

```bash
agentop server              # web: http://localhost:47292 · api/mcp: http://localhost:47291
agentop server --port 4000  # api on 4000, web on 4001
agentop server --bg         # detached, logging to ~/.agentistics
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `47291` | The **api + mcp** port; the web dashboard is served on this + 1 (default 47292) |
| `--bg` | off | Start detached in the background; logs go to `~/.agentistics` |

## `tui`

An **alias for [`start`](#start)** — it opens the control center, whose **Dashboard** screen is the
metrics dashboard this command used to be.

```bash
agentop tui        # identical to: agentop start
```

It was a second Ink application of its own: its own shell, its own keyboard, its own help panel,
drawing the same screens. Those screens are shared code now, so what the standalone app still owned
was a duplicate of the chrome around them — a second set of keys for the same material, and a second
place for the two to disagree. The command is kept because people have it in their fingers and in
their scripts.

Inside the app, the dashboard is one tab away:

| Key | Does |
|-----|------|
| `←`/`→`, `[`/`]` | Change tab — Services, Sessions, **Dashboard**, Logs, Cheat sheet, Help, Contribute |
| `1`–`6`, `tab` | Inside Dashboard: change screen — Overview, Projects, History, Costs, Harnesses, Hardware |
| `f` | Filter by harness |
| `,` / `.`, pgup/pgdn | Page a list (History, Projects, Costs) |
| `r` | Force a refresh |
| `q`, `ctrl+c` | Quit |

One difference worth knowing: the standalone command **started a server for itself** when none was
listening. The control center is the screen that starts and stops that server, so its Dashboard tab
starts nothing — when there is nothing to read it says so, and names the screen that fixes it. An
empty dashboard rendered as zeros would be a confident answer to a question it cannot answer.

Metrics match the web dashboard exactly: both price through `calcCost()`, Claude totals come from
`stats-cache.json` and every other harness from per-session sums. A metric a harness cannot
produce shows `N/A` rather than a misleading `0`.

Needs an interactive terminal — piping it runs like `agentop server`, exactly as `start` does.

---

## `watch`

Runs only the OpenTelemetry file watcher + OTLP metrics exporter (the same daemon
`server` runs in the background). Use this on a headless box that only needs to
feed Grafana/Datadog. See [docs/opentelemetry.md](opentelemetry.md).

```bash
agentop watch
```

---

## `session`

Start, list, attach to, name and stop assistant sessions in the background. A background session is
hosted by tmux on its own socket (`-L agentop`), so it survives `agentop` exiting and never mixes
with your own tmux sessions.

```bash
agentop session <harness> [-p "prompt"] [--bg] [--model <id>] [--effort <level>] [--cwd <path>] [--name "label"] [--task "<name>"]
agentop session ls     [--all] [--group none|tree|status|repo|project|task|harness|model|marked] [--json] [--width <n>] [--no-color]
agentop session list   [--json]
agentop session attach <id|name>
agentop session kill   <id|name>
agentop session rename <id|name> "label"
agentop session note   <id|name> "text"

# several at once, filed under one task — the form an assistant should drive
agentop session batch --task "<name>" [--cwd <path>] --session "<harness>: <prompt>" [--session ...] [--json]
agentop session open  "<task>" [--json]
```

### `ls` — the cockpit's table, printed

`agentop session ls` prints the very table the control center's **sessions** tab draws: aligned
columns, a section per project, and the state word first. By default it answers the question a
person means by "what have I got open" — **only what is running**, grouped by project:

```
  id     state         session                     worktree         task                 harness  project
agentistics  4  ────────────────────────────────────────────────────────────────────────────────────────
  df831  working       claude hook                 claude-hook      cli: claude hook     claude   agentistics
  bda77  needs approval  session ls on the cli     session-ls       cli: session ls      claude   agentistics

apresentacao  1  ───────────────────────────────────────────────────────────────────────────────────────
  b87a4  waiting       drop the invented metrics                                         claude   apresentacao
```

| Flag | Effect |
|------|--------|
| `--all`, `-a` | Also list what is **not** running: finished, lost and closed conversations |
| `--group`, `-g` | `project` (default), `tree` (the cascade), `repo`, `task`, `harness`, `model`, `status`, `marked`, `none` |
| `--json` | The same JSON `list --json` prints — one machine-readable shape, not two |
| `--width <n>` | Fit this many columns instead of asking the terminal |
| `COLUMNS` (env) | Read **only when stdout is not a tty** — how wide the reader is when there is no terminal to ask (`ls \| less -S`) |
| `--no-color` | Never colour, whatever the terminal says (`NO_COLOR` does the same) |

#### `--group tree` — the cascade

`tree` is not a dimension, it is an **arrangement**: the project as the root, and the segments of
each session's directory below it as branches. It answers the question grouping by project cannot —
*where* in the project — without filing one project as N unrelated folder names.

```
agentistics  4  ───────────────────────────────────────────────────────────
  3328b  waiting       cockpit colours                        antigravity
  8157f  working       live session notifications             antigravity

  .claude/worktrees  26  ───────────────────────────────────────────────────

    sessions-cascade  1  ─────────────────────────────────────────────────
  106d0  waiting       cockpit: cascade view                  claude

    session-monitor  1  ──────────────────────────────────────────────────
  a2157  working       MAIN                                   claude
```

Chains that never branch are joined into one node (`.claude/worktrees/session-monitor` is one row
while it is the only worktree; a second one splits `.claude/worktrees` out as a node of its own).
Two things it will never do, because both would draw a directory that is not there:

- a session **outside any repository**, or one whose directory is **gone** with nothing recorded at
  spawn, hangs straight off its own root with no branch;
- a worktree created **outside** the main checkout gets ONE branch named after its own folder — a
  relative path that does not exist is not synthesised.

It is not offered as a **filter**, and cannot be: a session belongs to every node on its path, so
"filter to `packages`" and "the band `packages`" could never be made to agree.

It is a **separate command from `list`**, not a flag on it: `list` is the tab-separated dump scripts
already read line by line, and widening it into columns underneath them would break those scripts
for a cosmetic reason. Both print the same `--json`.

Some particulars, all of them shared with the cockpit rather than re-decided here:

- **A session running outside agentop counts as running.** It is listed as `external` because
  `/proc` found a live assistant; what cannot be read there is its *activity*, never whether it is
  alive. It carries no id, because `agentop session attach` cannot resolve one for it.
- **An absent number is absent.** A conversation that recorded no usage shows no usage — the column
  does not exist unless something on screen fills it, and a `0` would be a confident wrong figure.
- **An empty list says why.** "Nothing is running" names the flag that lists the rest; a poll that
  failed says so and never claims the machine is idle.
- **Nothing exceeds the width.** Columns are measured across the page and the row is clipped as a
  last resort, so a narrow terminal loses cells rather than wrapping every row onto the next.
- **Piped output is plain.** No colour, no escapes, and no invented terminal width — the table comes
  out as wide as its content, so `agentop session ls | grep` works.
- **A pipe can still state a width**, and a pager is a reader: with no tty to ask,
  `COLUMNS=80 agentop session ls | less -S` fits 80 columns, the same lever `git` and `ls` honour.
  The order is `--width` → the terminal → `COLUMNS` → as wide as the content; a `COLUMNS` that is
  not a width (`abc`, `0`) is ignored rather than obeyed, and no minimum is imposed on one that is.

`--bg` detaches and returns immediately; without it the session takes over your terminal, and the
detach keystroke is printed first (read from your own tmux prefix, never assumed to be `Ctrl-b`).
`--cwd` defaults to the directory you are in and is resolved to an absolute path.

`batch` starts every session detached and files them all under one task; `open` brings that whole
task back later — safe to press twice, since a session still running is left alone rather than
duplicated and everything reopened retires the row it replaced. Sessions keep their name, note and
task across a reopen, and across a reboot: tmux is authoritative about what is running, the registry
about what it means.

Needs **tmux** (Linux, macOS); Windows support arrives with the PTY backend. Full command reference,
the cockpit, harness support table and where state lives: see
[docs/session-manager.md](session-manager.md).

To have **Claude Code itself** propose the split, write each session's prompt and drive `batch`, see
[`hooks`](#hooks) below.

---

## `backup`

```bash
agentop backup [--with-archive] [--with-raw] [--harness a,b] [--dest DIR]
               [--max-bundle MB] [--plan]
agentop backup schedule <off|daily|weekly>
agentop backup config [--layers a,b] [--schedule <off|daily|weekly>] [--schedule-layers a,b]
agentop backup status
agentop backup github setup <repository-url>
agentop backup github status
agentop backup github install-workflow
```

Carries this machine's whole agentistics history to another one. A backup always holds the computed
**metrics** plus a **repository manifest** that can rebuild every checkout, worktree, unpushed
branch and uncommitted diff; `--with-archive` adds the mirrored transcripts and `--with-raw` the
harness directories themselves. `--plan` prints what would be written and writes nothing.

**Live credentials are never included**, by decision — `restore` prints each one and the command
that re-establishes it. A schedule never carries the `repos` layer: rebuilding that manifest shells
out to git across every candidate directory, which is a thing a person asks for, not something a
timer does behind them. The schedule rides the daemon `agentop server` already runs, and `status`
says so when the server is down rather than reporting an empty history.

`github setup <url>` connects a **private** GitHub repository to hold versioned backups as releases
— it verifies the repository is private and that the token can push before writing anything.

→ **Full reference: [docs/backup.md](backup.md)**

---

## `restore`

```bash
agentop restore <archive> [--repos] [--only <repo>]
agentop restore <repository-url> [--release <tag>] [--from <machine>]
agentop restore github --list <repository-url>
```

Two phases and **resumable**: an interrupted restore continues rather than starting over. `--repos`
replays the repository manifest (clone, worktrees, bundle, patch) as structured argv — never a
joined string, and never a shell. Given a **repository URL** instead of a file it is the path back
on a machine that has nothing else: it lists the releases, shows what would be downloaded, asks, and
**verifies the sha256 against the release body before touching anything**. `--from <machine>` is
required as soon as several machines version into the same repository, where "the newest" would
otherwise be whichever ran last.

→ **Full reference: [docs/backup.md](backup.md)**

---

## `hooks`

Teach Claude Code to fan work out across several assistants through agentop.

```bash
agentop hooks install   [--hook-only | --skill-only]
agentop hooks uninstall [--hook-only | --skill-only]
agentop hooks status
```

Two pieces, installed together, each doing what the other cannot:

- **a skill** at `~/.claude/skills/agentop-parallel-sessions/SKILL.md` — the *knowledge*: when a task
  splits into independent pieces, how to propose the split, how to write a prompt for a session that
  cannot see your conversation, and the exact `agentop session batch` contract. Claude loads it when
  the task matches its description, so it costs **nothing** on a session that never parallelises.
- **a `SessionStart` hook** in `~/.claude/settings.json` — the *facts* a static file cannot hold:
  which agentop sessions are running right now, which one is blocked on a permission prompt, which
  task can be reopened in this directory. It prints **nothing** when there is nothing running.

**A hook does not infer anything** — it is a deterministic shell command on an event. The inference
is Claude's, reading what the skill teaches and what the hook injected. That is why the "activate
when it is relevant" half is a skill and not a hook that taxes every session.

Guarantees: nothing is written to `~/.claude` unless you run this command (`agentop setup` only
*suggests* it); every other key in your `settings.json` is preserved; a file that cannot be merged
into is refused rather than rewritten; installing twice changes nothing; `uninstall` removes exactly
what `install` wrote; and with no Claude Code present the command creates no directory and no file.

Claude never starts a session on its own — the skill's first rule is to propose, show the prompts,
and wait for a yes.

Full write-up, including why not `UserPromptSubmit` and why the session verbs are not MCP tools:
[docs/claude-integration.md](claude-integration.md).

---

## `autostart`

Register a mode to start with the system. On **Linux/WSL** this installs a systemd
**user** service at `~/.config/systemd/user/agentop-<mode>.service`, enables it
with `systemctl --user enable --now`, and runs `loginctl enable-linger` so it also
starts at boot without an active login. `enable` additionally installs a
`~/.bashrc` hook that runs [`agentop check-update`](#check-update) on every
terminal open. macOS and Windows print the manual step instead.

```bash
agentop autostart <mode> <enable|disable|status>
```

- `mode` ∈ `server` · `watch`
- `enable` — register + start the service (and add the terminal update hook)
- `disable` — stop and remove the service
- `status` — show enabled/active state; **omit the mode** to list all services

```bash
agentop autostart server enable    # start the dashboard at boot
agentop autostart status           # list every autostart service
agentop autostart watch disable    # stop the otel daemon service
```

---

## `upgrade`

Download and install the latest `agentop` release in place. (`update` is an alias.)

```bash
agentop upgrade
```

`agentop upgrade --help` (or `-h`) prints help. Any flag it does not know is refused and nothing is
upgraded — an upgrade only runs with no flags or with `--lang en|pt`.


---

## `uninstall`

Remove `agentop` from this machine.

```bash
agentop uninstall                # asks for confirmation, then asks separately about your data
agentop uninstall --yes          # skips the first confirmation only
agentop uninstall --keep-data    # never asks about, or touches, ~/.agentistics
```

It stops and disables the autostart service, removes the update-check hook from your shell rc, on
WSL removes the Windows logon task and the Startup-folder script, and removes the `agentop` binary
(and the `.bak` copy `agentop upgrade` keeps).

**Your data is a separate question, and the default is No.** `~/.agentistics` holds your metrics
history, preferences, task board and the **vault**. If you answer yes to deleting it, the vault and
its 24 recovery words become your responsibility: without them its secrets cannot be recovered, by
you or by anyone else. `--yes` never answers that question for you.

---

## `check-update`

Prints the "new version available" banner **only** when a newer release exists,
and stays completely silent otherwise — so it's safe to run on every shell start.
This is exactly what the `~/.bashrc` hook installed by `agentop autostart …
enable` runs.

```bash
agentop check-update
```

---

## Update detection

agentistics surfaces available updates in three places, all sourced from the same
version check:

- **On command run** — most `agentop` commands print the update banner in parallel
  with startup (non-blocking); `--version` appends the notice too.
- **On terminal / boot** — the `~/.bashrc` hook added by `autostart … enable` runs
  `agentop check-update` when you open a shell (silent when you're current).
- **On the dashboard** — a bell notification plus a **mode-aware** upgrade modal
  showing the exact command (`agentop upgrade` then `systemctl --user restart agentop-server`). A
  periodic (~6h) server re-check pushes the notification live over SSE.


---

## `doctor`

Runs the exposure preflight: a handful of checks that decide whether this instance is safe to expose.
Exits non-zero on any failure, so going live can be gated on one command.

```bash
agentop doctor              # check against the current profile
agentop doctor --exposed    # check against the strict public bar
```

`--exposed` evaluates as if `AGENTISTICS_EXPOSURE=public` were already set, which is how you
verify readiness **before** flipping it.

What it checks:

| Check | Fails when |
|---|---|
| `local-shell` | `/api/exec`, `/api/chat-tty`, the host transcript readers or `/api/mcp-action` are still reachable |
| `tls` | `AGENTISTICS_TLS` is unset on a public profile |
| `trust-proxy` | *(warn)* forwarded-IP trust does not match the deployment, so per-IP limits apply to everyone at once |
| `cors` | A plaintext origin sits in `AGENTISTICS_ALLOWED_ORIGINS` |
| `native-bind` | The native server listens on a non-loopback address on a public profile |

A check that could not be verified reports a **failure**,
not a reassuring pass. See [exposure.md](exposure.md) for the exposure runbook.

---
