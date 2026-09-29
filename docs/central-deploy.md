# Running a central

A **central** is the instance that aggregates coding-assistant metrics from many machines. This
document is about **getting one running**, in every shape the product supports.

**Publishing it on the internet is a separate decision** with its own variables and its own
checklist — [`docs/exposure.md`](exposure.md). Nothing on this page opens a port to the world; a
central built by following it is reachable from its own host and nowhere else until you choose
otherwise.

- Running one machine's own dashboard instead? That is `agentop start`, and it needs none of this.
- The security model behind both documents is [`docs/security.md`](security.md).

---

## Prerequisites

- **Docker Engine ≥ 24 and Compose ≥ 2.20** — for the two Docker shapes. Not needed for the native
  one.
- A Linux or macOS host with ~512 MB free RAM.
- Outbound internet for the initial image pull or build.

---

## 1. Pick a shape

A central is one program that can be run three ways. They are genuinely different deployments, not
variations, and the choice is yours rather than inferred:

| Shape | Flag | What it does | Needs |
|---|---|---|---|
| **Published image** | `--image` | Pulls `ghcr.io/agentistics/agentistics` and runs it in Docker | Docker |
| **Built from source** | `--build` | Builds the image from a checkout, then recreates the container | Docker + a clone |
| **Native** | `--native` | The `agentop` binary *is* the server — no Docker, no container | An external `MONGO_URL` |

Two rules the CLI and the terminal cockpit both follow:

- **A shape that cannot work here is refused in a sentence, never silently swapped.** `--native` on
  a central configured for the bundled Mongo tells you the database is a Docker service and how to
  change it. It does not quietly start Docker instead.
- **The choice is recorded** (`AGENTISTICS_CENTRAL_RUNTIME` in `central.env`, read by the CLI only)
  so every later `up`, `restart`, `logs` and `status` resolves the same way the first one did.

Not sure? **`--image` is the one that works everywhere Docker does**, needs no clone, and is what
`agentop central up` picks by itself outside a checkout.

---

## 2. Configure it — `central.env`

Every shape reads the same file. Generate it with the wizard, which asks for the port, org, **who
will reach it**, the bind interface, the database and the shape, generates the secrets with
`openssl`, and writes it `chmod 600`:

```bash
agentop central init      # anywhere — the installed binary is enough
./central.sh init         # the same wizard, from a checkout
```

### "Who will reach this central" — and why it is a question at all

The wizard asks this, and it is the setting with the most consequence:

```
Who will reach this central
› Only this machine — nothing else can connect
  A network I trust — LAN, or a tailnet
  The internet — published through a tunnel or a reverse proxy
```

It looks like something that ought to be automatic. An API has no switch for "am I on the
internet" — it simply is. **The difference is that this is not a question about reach; it is a
question about capability.**

A central shares its code with a solo machine's dashboard, and that dashboard legitimately runs
shell on its own host (`/api/exec`), spawns the local assistant CLI (`/api/chat-tty`), reads the
machine's raw transcripts and rewrites `~/.claude.json`. Correct on your own laptop; catastrophic
on a box strangers can reach. So the real question is *which of those capabilities should still
exist, given who can get here* — and answering "the internet" makes them stop existing, with no
opt-in to bring them back.

**It cannot be inferred.** From inside the container, a central behind a Cloudflare tunnel and a
central nobody can reach are identical: both see a loopback bind and the same request headers. The
tunnel is outside the process, often on another host entirely. Only you know the intent.

Answering **the internet** writes `AGENTISTICS_EXPOSURE=public`, `AGENTISTICS_TEAM_TLS=1` and
`AGENTISTICS_TRUST_PROXY=1`, and keeps `BIND_IP=127.0.0.1` **on purpose** — the entry point in
front must be the only way in, or everything it enforces can be walked around by addressing this
host directly. You can still override the bind (a tunnel on another machine is a real deployment);
the wizard warns rather than refuses. Then run `agentop doctor --exposed` before the first outside
request — [`docs/exposure.md`](exposure.md) is the full runbook.

Or copy the annotated template and edit it:

```bash
cp docker/central.env.example central.env
chmod 600 central.env
openssl rand -hex 32      # → AGENTISTICS_TEAM_SESSION_SECRET (or leave it empty; see below)
```

> **Name it `central.env`, not `.env`.** `bun run dev` auto-loads a plain `.env`, so a developer's
> local instance would wrongly inherit `AGENTISTICS_TEAM_CENTRAL=1` from it.

> **There is no dashboard password.** A central authenticates **accounts**. On first boot it has
> none, so it prints a one-time **owner setup token** to its log and the browser asks you to create
> the owner with it. Everyone else gets their own account, invited by the owner.

### The variables

| Variable | Default | What it does |
|---|---|---|
| `APP_PORT` | `48080` | Host port. A member/solo machine uses 47291/47292, so a central on the same host does not collide |
| `BIND_IP` | `127.0.0.1` | Interface the container publishes on. See [Which interface](#3-which-interface) |
| `MONGO_URL` | `mongodb://mongo:27017/?replicaSet=rs0` | The bundled Mongo. Point it elsewhere and the bundled container is not started at all |
| `MONGO_DB` | `agentistics` | Database name |
| `AGENTISTICS_TEAM_CENTRAL` | `1` | What makes this instance a central |
| `AGENTISTICS_TEAM_ORG` | `default` | Organisation namespace. Naming it also makes first boot create a team named after it |
| `AGENTISTICS_TEAM_SESSION_SECRET` | *(generated)* | HMAC key for session cookies. Leave empty and the central generates one and persists it. It is **never** derived from a password — a value equal to `AGENTISTICS_TEAM_PASSWORD` refuses to boot |
| `AGENTISTICS_TEAM_PASSWORD` | *(unset)* | **Legacy, pre-accounts. Do not set it.** It gates nothing on a modern central and only makes the setup look like it needs a shared credential |
| `AGENTISTICS_TEAM_INGEST_TOKEN` | *(empty)* | Bearer token for `POST /api/team/ingest`. Empty allows unauthenticated ingestion — only sane on a private instance |
| `AGENTISTICS_CENTRAL_USER` | *(empty)* | Self-contribution — see [below](#self-contribution) |
| `AGENTISTICS_CENTRAL_RUNTIME` | *(from the wizard)* | Which shape above. **Read by the CLI only**; no compose passes it into the container |
| `AGENTISTICS_IMAGE` | *(the CLI's own version)* | Pin the published image, e.g. `ghcr.io/agentistics/agentistics:latest` |

**Every variable that decides what this instance is *allowed to do* lives in
[`docs/exposure.md`](exposure.md)** — `AGENTISTICS_EXPOSURE`, `_TEAM_TLS`, `_TRUST_PROXY`,
`_ALLOW_LOCAL_SHELL`, `_ALLOWED_ORIGINS`, `_INGEST_ONLY`, `_OIDC_*`. They are deliberately not
repeated here: a reader who only wants a central running on their LAN should not have to skim
exposure controls, and a reader who is publishing one should read that page whole.

### Self-contribution

Set `AGENTISTICS_CENTRAL_USER` to the central machine's own identity and the same instance also
reports its own assistant usage — one machine acting as central *and* member. It makes compose
mount the host's `~/.claude`, `~/.codex`, `~/.gemini` and `~/.copilot` **read-only** into the
container (`docker/central.selfcontrib.yml`, merged automatically).

**Do not set it on a central you intend to publish.** That instance would be holding every raw
transcript on the machine. Left empty, a central has no host filesystem access at all.

---

## 3. Which interface

`BIND_IP` decides what can reach the central *before* any of the exposure controls apply.

| Goal | `BIND_IP` | Reachable from |
|---|---|---|
| This host only **(default)** | `127.0.0.1` | This host's browser, a tunnel, or a local reverse proxy |
| A private tailnet | your Tailscale IP, e.g. `100.x.y.z` | This host + tailnet peers |
| The whole LAN | `0.0.0.0` | Every interface the host can route |

**The default is loopback on purpose.** It used to be `0.0.0.0`, which meant a fresh install landed
on every interface the host could route — including, on plenty of machines, one facing the
internet. Widening it is now a decision you make.

**To publish outside a tailnet, do not widen `BIND_IP`.** Keep loopback and put a tunnel or a TLS
proxy in front — [`docs/exposure.md`](exposure.md).

> **WSL2:** binding a specific non-loopback IP means Windows' `localhost` forwarding no longer
> reaches the app — browse via that IP instead. The default `127.0.0.1` keeps
> `http://localhost:<APP_PORT>` working from the host.

---

## 4. Bring it up

### From the CLI — works everywhere

```bash
agentop central up                 # the shape recorded by `init`
agentop central up --image         # published image, no clone needed
agentop central up --build         # build from this checkout
agentop central up --native        # the binary itself, foreground
agentop central up --native --bg   # …detached, logging to ~/.agentistics/agentop-central.log
```

On first run with no `central.env` it offers the wizard. `-y` / `-n` answer that up front for
unattended runs, and `--no-cache` / `--cache` control the image build.

The other actions follow the same recorded shape:

```bash
agentop central status
agentop central logs
agentop central restart
agentop central down          # keeps the data volume
agentop central pull          # fresh image + recreate
agentop central setup-token   # reissue the one-time owner token (refused once an owner exists)
agentop central reset-password --email you@example.com
```

### From the terminal cockpit

`agentop` (bare) opens the control center. On the **Services** tab, select `agentistics central`
and press the start verb — there is **one verb per shape this box can actually run**:

```
Start (docker · published image)   pulls ghcr.io/agentistics/agentistics — no build, no checkout needed
Start (docker · build from source) builds the image from this checkout, then recreates the container
Start (native · this terminal)     runs here until you quit — no Docker needed
Start (native · background)        detaches and keeps running
```

Shapes this box cannot run are **not offered** — and the detail pane says why, under
`NOT AVAILABLE HERE`. A verb that fails on principle is worse than a missing one; an absence with
no explanation reads as a broken screen, so you get neither.

The cockpit and the CLI resolve this through the same module and pass the same flags, so they can
never offer different deployments.

### From a checkout — `central.sh`

The wrapper bakes in `-p team-mode`, `--env-file central.env`, the right overlays, and
`--build --force-recreate`:

| Command | What it does |
|---|---|
| `./central.sh init` | (Re)generate `central.env` interactively |
| `./central.sh up` | Build + (re)create the containers. Offers `init` if `central.env` is missing |
| `./central.sh restart` | Restart the `app` container without rebuilding |
| `./central.sh logs` | Follow the app log |
| `./central.sh status` | Containers + health |
| `./central.sh down` | Stop + remove containers — **keeps** the Mongo volume |
| `./central.sh pull` | Rebuild from a fresh base image |
| `./central.sh doctor --exposed` | The pre-publication preflight, run inside the container |
| `./central.sh setup-token` | Reissue the one-time owner setup token |
| `./central.sh reset-password --email <address>` | Reset an account's password. `--clear-mfa` also drops its second factor |

`bun run up:central` and `bun run init:central` are aliases for the first two. Override the
defaults with `PROJECT=… ENV_FILE=… ./central.sh up`.

### From raw compose

The files are in [`docker/`](../docker/README.md), one per thing you might run, and each is
directly runnable:

```bash
# built here, bundled database
docker compose -p team-mode --env-file central.env \
  -f docker/central.yml -f docker/central.localdb.yml \
  up -d --build --force-recreate

# published image, bundled database
docker compose -p team-mode --env-file central.env \
  -f docker/central.image.yml -f docker/central.localdb.yml \
  up -d --pull always --force-recreate

# published image, external database — no local Mongo at all
docker compose -p team-mode --env-file central.env \
  -f docker/central.image.yml \
  up -d --pull always --force-recreate
```

`--force-recreate` is not a habit: a plain `up -d` does **not** replace a container whose image was
rebuilt, so your new code silently does not run.

### First boot — the owner account

The first boot with no owner prints a one-time setup token to the log, and `up` prints it for you.
If it scrolled past, **do not go hunting for it in the logs — mint a new one**, which invalidates
the old:

```bash
agentop central setup-token     # deployed with the CLI (any shape)
./central.sh setup-token        # deployed from a checkout
```

Both run the reissue *inside* the container, which is where the database is reachable. Reading it
back out of the logs is the fragile path: `docker compose logs` needs `-f`/`--env-file` to resolve
the project from an arbitrary directory, and the banner may have rotated out entirely.

Open the dashboard, create the owner (name, e-mail, password + that token), and enrol a second
factor. **Every profile requires an owner to hold one** — an owner reaches every team's data and
every admin route, and account recovery is self-service through that factor.

**Locked out?** There is no e-mail reset — a self-hosted central has no mail server, and a reset
link it cannot deliver is worse than none. Recovery is at the host, where whoever runs it already
holds the database:

```bash
agentop central reset-password --email you@example.com               # omit --email to list accounts
agentop central reset-password --email you@example.com --clear-mfa   # also lost the 2FA device
```

---

## 5. The database

### Bundled MongoDB (default)

`docker/central.localdb.yml` starts `mongo:7` with `--replSet rs0`. Its healthcheck runs an
idempotent `rs.initiate()` — configuring the replica set on first boot, a no-op thereafter. The
member host **must** be `mongo:27017`, the same hostname the app uses in `MONGO_URL`, so the
driver's topology check passes.

**Mongo is never published to the host.** Only the app container reaches it, over the compose
network. It also runs without `--auth`, deliberately: enabling it on a replica set additionally
requires an internal-authentication keyFile, and `MONGO_INITDB_ROOT_*` only creates the user on a
*fresh* data directory — switching it on would lock every existing central out of its own database.
`agentop doctor` reports this as a warning rather than a failure precisely because the port is
unreachable from outside the compose network.

### External — Atlas or your own Mongo

Point `MONGO_URL` at a connection string (`mongodb+srv://…`, or `mongodb://host:27017/db`) and no
bundled container is started. The wizard asks for this directly:

```
Database:
  › Bundled Mongo (Docker starts it for you)
    External URI — Atlas, or a Mongo you run yourself
```

With an external database the **native** shape becomes available — the `agentop` binary is the
server, no Docker anywhere. This is the path for someone who installed only the CLI:

```bash
agentop central init      # choose "External URI", paste the connection string
agentop central up --native --bg
```

Notes: the connection string lands in `central.env` (`chmod 600`) — treat that file as a secret.
Atlas is a replica set, so change streams (used for live team refresh) work out of the box;
whitelist this host's outbound IP and use a database user scoped to the `agentistics` database.

---

## 6. Keeping it running

`agentop autostart` registers a mode with the host's own service manager. **None of them needs
root.**

```bash
agentop autostart central enable
agentop autostart central status
agentop autostart central disable
```

| Manager | Where | What gets written |
|---|---|---|
| **systemd** (Linux, default) | `~/.config/systemd/user/agentop-central.service` | A user unit, enabled with `systemctl --user enable --now` |
| **launchd** (macOS, default) | `~/Library/LaunchAgents/com.agentistics.agentop-central.plist` | A user agent, loaded with `launchctl bootstrap gui/$UID` |
| **pm2** (anywhere it is installed) | a pm2 process named `agentop-central` | `pm2 start … --name agentop-central` |

Pick one explicitly with `--manager systemd|launchd|pm2`. **pm2 is never chosen by default even
when installed** — it is a process manager you chose for your own apps, and quietly filing agentop
into it (where it appears in every `pm2 ls` and is caught by `pm2 restart all`) is your decision.

**The unit follows the shape.** A native central holds its process, so it becomes a normal
long-running service. A Docker one *returns* as soon as the container is up, so it becomes a
`Type=oneshot` + `RemainAfterExit=yes` unit — registering it as long-running produces a unit that
reads `inactive (dead)` one second after a perfectly successful start, and every status readout
then lies. The same distinction sets launchd's `KeepAlive` and pm2's `--no-autorestart`.

**Each manager names the one step it cannot take for you**, because a service that does not survive
a reboot while you believe it will is worse than none:

- **systemd** — `loginctl enable-linger <you>`, so the service starts at boot without a login.
  `agentop` attempts it and reports if it could not.
- **launchd** — a *user agent* starts at **login**, not at boot. For a service that runs with nobody
  logged in, install a LaunchDaemon under `/Library/LaunchDaemons` (that needs root).
- **pm2** — `pm2 save`, then `pm2 startup` and run the command it prints (root, once).

`enable` also installs a guarded `agentop check-update` line in `~/.bashrc` / `~/.zshrc`, which
prints a banner only when an update exists.

### Managing the compose stack yourself

If you would rather not use `agentop autostart` at all, a system-level unit works fine — note
`Type=oneshot`, for the reason above:

```ini
# /etc/systemd/system/agentistics.service
[Unit]
Description=agentistics central
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/agentistics
ExecStart=/usr/bin/docker compose -p team-mode --env-file central.env -f docker/central.yml -f docker/central.localdb.yml up -d
ExecStop=/usr/bin/docker compose -p team-mode --env-file central.env -f docker/central.yml -f docker/central.localdb.yml down

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now agentistics
```

The containers carry `restart: unless-stopped`, so Docker itself brings them back after a crash or
a reboot; the unit above only has to bring the stack up once.

---

## 7. Connect a member

A **member** is a developer's machine that pushes its *computed* metrics — never chat content — to
a central.

**1. Mint a token on the central.** Settings → Team. The machine's **name is set here, on the
token**; the member resolves its own name from `/api/team/whoami`. The same panel rotates a token
(migrating that member's history to the new identity), revokes it, or renames the machine.

**2. Connect the machine.**

```bash
agentop setup                                   # interactive: pick "join a central"

# a token minted by a central with a public URL configured carries that URL
agentop member connect --token <minted-token> [--org <org>]

# a bare token needs the address beside it
agentop member connect --endpoint http://<central-host>:48080 --token <minted-token>
```

`member connect` verifies the token against `GET <endpoint>/api/team/whoami` **before writing
anything**, so a bad token never leaves a half-written config.

**3. Check or leave.**

```bash
agentop member status
agentop member leave
```

Presence is WebSocket-authoritative: online in real time while the reverse channel is live, offline
within ~8s of the app being killed. Members follow the **central's** push cadence (default 30s,
15s floor, 5s in express mode) and can only go slower, plus they push on local change. If the
central's database is wiped, the token is rotated, or the endpoint changes, the member detects the
signature change and re-pushes its full history automatically. A revoked machine resets itself back
to solo.

### A machine in Docker

```bash
docker compose -f docker/machine.yml up -d --build    # web: http://localhost:47292
docker compose -f docker/machine.yml logs -f
docker compose -f docker/machine.yml down
```

`agentop start` offers this as the **docker** option. Configure the machine on the **host** first
(`agentop member connect …` writes `~/.agentistics`), then bring the container up — it mounts that
same directory so it inherits the endpoint and token, and the harness dirs read-only.

> Run the machine in Docker **or** natively, never both: two members with the same token push the
> same data and flap presence.

Two container caveats, both deliberate trade-offs rather than bugs:

- **Live session detection needs `pid: host` *and* the host user's uid.** `pid: host` is already
  set; `/proc/<pid>/cwd` is ptrace-gated, and the image runs as uid 10001 while assistants run as
  you. Uncomment the `user:` line in `docker/machine.yml` to trade the image's unprivileged-user
  hardening for the feature. The dashboard *says* detection is unavailable rather than showing a
  confident zero.
- **Persisting anything back to `~/.agentistics` needs that same uid line.** The mount is
  read-write, but uid 10001 cannot write a directory owned by you.

---

## 8. Upgrading

agentistics surfaces "update available" as a banner on commands, via the shell hook on terminal
open, and on the dashboard (a bell notification plus a mode-aware modal with the exact command for
your role).

```bash
agentop check-update    # banner only when outdated, silent otherwise
agentop upgrade         # replace the binary
agentop --version
```

**A central:**

```bash
agentop central up             # whatever shape it runs — rebuild or re-pull, then recreate
agentop central pull           # image path: fresh image + recreate
./central.sh up                # from a checkout, after git pull
```

**A member:**

```bash
agentop upgrade
systemctl --user restart agentop-server      # or however you launched it
```

### Upgrading an older central

| Change | Effect | What happens |
|---|---|---|
| The container runs as **uid 10001** instead of root | the existing `agentistics_data` volume is root-owned, so the app cannot write preferences | `central.sh up` chowns it once, automatically. By hand: `docker run --rm --user 0 -v team-mode_agentistics_data:/d alpine chown -R 10001:10001 /d` |
| **`BIND_IP` defaults to `127.0.0.1`** | a central teammates reached directly over the LAN becomes unreachable | `central.sh up` prints a notice when `BIND_IP` is unset. Add `BIND_IP=0.0.0.0` or your tailnet address |
| **The compose files moved to `docker/`** | a hand-rolled `docker compose -f docker-compose.yml …` no longer resolves | Use the paths in [`docker/`](../docker/README.md), or the wrappers, which handle it. The central's project name (`team-mode`) is unchanged and is now pinned in the files themselves |
| **The session cookie format changed** | existing cookies are invalid | Everyone signs in again once |

Accounts, machine tokens, teams, tags and all metrics are untouched, and existing passwords keep
working — the 12-character policy applies when a password is *set*, not when it is used.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `MongoServerError: not primary` | Replica set not yet initialised | Wait for the `mongo` healthcheck to go green (`docker compose ps`) |
| Dashboard shows **zero members** after a host reboot | the `mongo` container stayed down while `app` came back | `docker start team-mode-mongo-1` — the volume is intact. Permanent fix ships as `restart: unless-stopped`; migrate an old deploy with `agentop central up` |
| The archive-consent gate reappears on every `up` | the data volume was mounted where the app does not write | Fixed: it is `/data/.agentistics` (the image runs with `HOME=/data`). Re-run `agentop central up` to regenerate the compose |
| `AGENTISTICS_EXPOSURE` seems to do nothing | an older generated compose did not pass it through | Fixed. Re-run `agentop central up`, then confirm with `agentop doctor --exposed` |
| Port already in use | something else on `APP_PORT` | Change it in `central.env` |
| Container exits immediately | a missing or malformed variable | `agentop central logs` |
| A native central will not start | `MONGO_URL` still points at the bundled service | `agentop central init`, choose the external URI |

---

## Next

- **[docs/exposure.md](exposure.md)** — publishing this central safely, and the checklist to pass first.
- **[docs/security.md](security.md)** — the threat model and what each control does and does not do.
- **[docs/github-actions.md](github-actions.md)** — CI runners pushing to a central.
- **[docker/README.md](../docker/README.md)** — what each compose file is.
