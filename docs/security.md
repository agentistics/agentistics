# Security model

What protects an Agentistics instance, how the pieces fit together, and — as importantly —
what each control does **not** do.

This is the reference. Two neighbouring documents cover the other angles:
[exposure.md](exposure.md) is the operator runbook for publishing a central, and
[SECURITY.md](../SECURITY.md) is the vulnerability disclosure policy.

---

## 1. What is being protected

A central holds, for every developer and CI runner in an organisation: project paths, git
remotes, session titles and first prompts, token and cost aggregates, machine tokens (hashed),
account password hashes, and — only when `AGENTISTICS_CENTRAL_USER` is set — read-only mounts of
the host's `~/.claude`, `~/.codex`, `~/.gemini` and `~/.copilot`, which contain **raw
conversation transcripts**.

Members never push chat. Raw transcripts are fetched on demand over the reverse WebSocket and
are never stored centrally.

Every machine — solo, member or central — also holds credentials of its own, and those are
**encrypted at rest, never plain text** ([§7a](#7a-secrets-at-rest--every-secret-is-sealed-never-plain-text-under-0600)):

| Secret | Where (under `~/.agentistics`) | Purpose |
|---|---|---|
| GitHub PAT for versioned backups | `github-backup.sealed` | `github-backup` |
| Member tokens for each central (`team.connections[].token`) | `connections/tokens.sealed` — no longer in `preferences.json` | `central-token` |
| X25519 private key of the sealed envelope channel | `connections/envelope-key.sealed` | `envelope-key` |
| A central's password, session secret, ingest token, `MONGO_URL` | `central/secrets.sealed` — `central.env` keeps only the non-secret variables | `central-env` |
| Provider API keys of the native runtime | `provider-keys/<id>.sealed` (the engine, through engine-api 1.5 `secrets`) | `engine/provider-key` |

## 2. Threat model

Defended against:

| Attacker | Primary controls |
|---|---|
| **Unauthenticated internet** — scans the hostname, hits every route, brute-forces login, fuzzes tokens | capability guard, deny-by-default gate, rate limiting, security headers |
| **Authenticated low-privilege account** (legitimate or stolen) escalating to owner, to other teams' data, or to the host | role gate, per-team scoping, capability guard, step-up |
| **Malicious website in a logged-in user's browser** | `SameSite=Strict`, CSRF origin checks, CSP `frame-ancestors 'none'`, no wildcard CORS |
| **Compromised member machine** with a leaked machine token | per-machine tokens, individually revocable, sha256-hashed at rest |
| **Supply chain** — a malicious transitive dependency or tampered image | `bun audit` in CI, lockfile drift check, Dependabot |

Explicitly **out of scope** (see §7 for why this matters):

- A compromised **host**. Shell on the machine reads `central.env` and the Mongo volume.
- A malicious or compromised **owner account**. Owner is fully trusted by design.
- A compromised **Cloudflare account** or tunnel credential.
- Physical access.
- Vulnerabilities in the AI coding assistants whose data this project reads.

## 3. Trust boundaries

```
   internet ─┬─► Cloudflare edge  (WAF, rate limit, optional Access)
             │
             └─► tunnel (outbound-only; no inbound port on the host)
                   │
                   ▼
              ┌──────────────────────────────────────────┐
              │ container: uid 10001, read-only rootfs,   │
              │            cap_drop ALL, no-new-privs     │
              │  ┌────────────────────────────────────┐   │
              │  │ app: capability guard → rate limit │   │
              │  │      → CSRF → auth → role → MFA    │   │
              │  │      → step-up → handler → scoping │   │
              │  └────────────────────────────────────┘   │
              └───────────────┬──────────────────────────┘
                              │ compose network only
                              ▼
                        MongoDB (never published, never tunnelled)
```

Each boundary is independent. A failure of the application logic still meets a container with no
root, no capabilities and an immutable filesystem; a failure of the container still meets a host
with no inbound port open.

## 4. The request pipeline

Order matters, and every step is where it is for a reason
(`packages/server/server/index.ts`):

| # | Step | Why here |
|---|---|---|
| 1 | Path normalisation | `//api/x` must not slip past exact-match route tables |
| 2 | `INGEST_ONLY` short-circuit | a public ingest instance exposes nothing else, not even a 401 |
| 3 | Client IP resolution | everything below keys off it; forwarded headers only trusted under `AGENTISTICS_TRUST_PROXY` |
| 4 | **Rate limiting** | before any expensive work, so an unauthenticated caller cannot spend CPU |
| 5 | **CSRF** | before auth, so a cross-site request is refused without touching the session |
| 6 | **Capability guard** | before auth, so an exposed instance does not reveal whether the caller is authenticated |
| 7 | **Host allowlist** (`localShell` routes only, HTTP and WS upgrades alike) | closes DNS rebinding before a host-power route dispatches — see §4a for what it does and does not close |
| 8 | **Auth** — session cookie → principal | deny-by-default: everything under `/api` outside `AUTH_PUBLIC` |
| 9 | **Role** — owner-only admin paths | includes nested detail routes |
| 10 | **MFA enrolment** gate | a `public` owner without a second factor reaches only enrolment |
| 11 | **Step-up** | destructive operations need proof of presence, not just of identity |
| 12 | Handler | per-resource authority (tags by source, machines by ownership) |
| 13 | **Team scoping** of the response | a principal never receives another team's rows |
| 14 | Security headers stamped on the way out | in a wrapper, so a new route cannot forget them |

## 4a. S-1 — the local server binds every interface: what the Host allowlist closes, and what it leaves open

**The finding.** HIGH, pre-existing, found 2026-09-27 by the UI.4 security review of the
provider-key settings. The native `agentop server` binds `0.0.0.0` unconditionally, on both ports
(`index.ts`, `Bun.serve({ hostname: '0.0.0.0', … })`), regardless of profile — while `exposure.ts`'s
own `local` profile is documented as "solo machine on 127.0.0.1" and grants it full host power
(`localShell`, `localChat`, `localTranscripts`, `localProcesses`, `mcpAdmin`) with no authentication
at all. Nothing in the request pipeline checked the *Host* header, and the one place that came
close — `wsInputOriginOk` (`sessions/input-protocol.ts`), guarding the fleet-input and utility-shell
WebSocket upgrades — compares **Origin against Host**, never either one against the machine's own
identity. So every `localShell` route — the utility shell, the fleet input/screens sockets,
`/api/provider`, `/api/exec`, `/api/tasks`, `/api/backup`, and everything else §6's capability-guard
row lists — answered two callers it was never meant to:

1. **DNS rebinding.** A page served from `attacker.example`, whose name is re-pointed at `127.0.0.1`
   after the browser has already loaded it, is same-origin with itself: the browser sends both
   `Origin: https://attacker.example` and `Host: attacker.example`, and the Origin-vs-Host
   comparison above passes them as a matching pair.
2. **Any peer that can already reach the port** — the LAN, and the tailnet (the machine holds a
   `100.x` address) — since binding every interface serves the same routes to them, unauthenticated,
   with no Host check at all.

`agentop doctor` never caught this: its bind check reads `BIND_IP`, which only the Docker
deployment sets. The native binary's bind is not env-configured, so the check judged a variable the
native server never reads, on the one deployment it should have flagged.

**The gate.** `host-allow.ts`'s `hostGate` is called from ONE place in the pipeline — step 7 above,
right after the capability guard and before any route handler — so it covers HTTP routes and the
WebSocket upgrades alike; a socket is refused at the same point an ordinary request would be, before
either reaches a handler. It applies only to the requests `capability-guard.ts` already classes as
`localShell`, walked from that same table rather than a second list — a `localShell` route added
later is covered by having been added, the guarantee `capability-guard.ts` already gives itself for
everything else. It is skipped entirely wherever the profile has revoked `localShell`
(`lan`/`public` without the opt-in): those requests still get the existing 403, unchanged.

A request's Host passes when it is, on one of the server's own two ports:
- a loopback name or address — `localhost`, `127.0.0.0/8`, `::1`;
- the machine's own hostname, or `<hostname>.local`;
- the machine's MagicDNS name, full (`<machine>.<tailnet>.ts.net`) and short (`<machine>`) — read
  from `tailscale status --json` (`Self.DNSName`) at startup and on the same refresh timer, because
  it is not the OS hostname (under WSL the kernel reports the Windows machine's name). Tailscale
  absent, stopped or answering something unreadable adds no names, keeps the last known ones, and is
  logged once;
- any of the machine's own interface addresses, the tailnet included — read from the OS at startup
  and refreshed on a timer, **never resolved per request**;
- an exact entry in `AGENTISTICS_ALLOWED_ORIGINS`, or the Tailscale Serve secure origin the machine
  detects for itself (`secure-origin.ts`) — that origin exactly, and its name on the server's own
  ports too.

Anything else is refused with `421 Misdirected Request`, naming the refused Host and the env var that
would allow it. The refusal is audited (`host.misdirected`, path and refused Host). The ports rule is
real: a MagicDNS name (`http://<machine>:47292`, `http://<machine>.<tailnet>.ts.net:47292`) passes
on the server's own ports and is refused on any other, exactly like the hostname — and only while
Tailscale reports it, so on a machine where `tailscale status` cannot be read, address the machine by
its tailnet IP or add the origin to the allowlist. A request with no Host at all (or an empty one, or
one that does not form a readable URL) never reaches the gate: it is answered `400` on every route,
before anything parses its URL, with a JSON body naming the problem (`missing_host` /
`bad_request_target`) — it used to surface as a `500`, because Bun builds the request URL out of the
Host and the first parse threw. In dev (`bun run dev`), Vite proxies `/api` with
`changeOrigin: true`, so the server sees Vite's rewritten Host and the gate cannot see rebinding
aimed at the Vite port — a dev-only gap.

**How to allow a name on purpose.** Add the exact `scheme://host:port` to
`AGENTISTICS_ALLOWED_ORIGINS` (comma-separated, same variable CORS and CSRF already read) and
restart `agentop server` — the list is read at startup, not polled.

**What it closes.** DNS rebinding specifically: the attacker's page's Host is its own domain, never
one the gate accepts, so it is refused regardless of which Origin the browser sends alongside it.

**What it explicitly does not close:**
- **Reachability.** The gate decides which *Host* is acceptable, not who may send a request with
  one. A phone on the tailnet addressing the machine by its tailnet name or address keeps
  working — that Host is legitimately the machine's own — and that is also exactly why any peer that
  can already reach the port and sends one of the machine's own names passes unchanged. For a
  non-browser client this is trivial: it sends whatever Host it likes. The gate closes the one thing
  a page running in a stranger's browser cannot forge — a Host equal to the machine's own name — and
  nothing about who is allowed to hold that name in the first place.
- **The softer capabilities.** `localChat`, `localTranscripts`, `localProcesses` and `mcpAdmin` are
  not `localShell`; a route classed under one of them does not ride this gate.

**The doctor check.** `agentop doctor` (and `--exposed`) gains a `native-bind` check that reads the native
server's ACTUAL listening sockets — `/proc/net/tcp{,6}` on Linux, `lsof` on macOS — instead of
`BIND_IP`, which the native binary never sets.

| Bind | Profile | Verdict |
|---|---|---|
| loopback only | any | pass |
| wildcard / non-loopback | `local` | **warn** — names S-1 and decision (b) below |
| wildcard / non-loopback | `lan` | pass — intended |
| wildcard / non-loopback | the strict `--exposed` bar (`public`) | **fail**, unless loopback |
| unreadable | any | **fail** — never a reassuring pass |
| nothing listening | any | warn — nothing could be verified |

**Open — decision (b), not yet shipped.** Whether a non-loopback peer must additionally
authenticate (pairing, or a token), or whether `local` instead binds `127.0.0.1` and a wider bind
becomes an explicit opt-in, is pending with the product owner. Until it is decided, a LAN or
tailnet peer that can reach the port uses every `localShell` route with no authentication at
all — including replacing a stored provider key and base URL. (Closing THAT specific exposure — to
a new origin, and to a cross-site request — is F-1/F-2 in the provider routes, not this finding.)
The Host allowlist above narrows WHICH Host such a peer must present; it does not decide whether
that peer should be trusted with `localShell` at all.

## 5. Identity and sessions

**Login** (`/api/iam/login`) verifies an argon2id hash and answers a generic 401 for both an
unknown e-mail and a wrong password, so it cannot be used to enumerate accounts. When a second
factor is enrolled it issues **no cookie**: it returns a five-minute HMAC challenge that grants
nothing on its own, exchanged at `/api/iam/login/mfa` for a session.

**The session cookie** is stateless: `expiryMs.accountId.sessionVersion.issuedAt.HMAC`. It is
`HttpOnly`, `SameSite=Strict`, `Path=/`, and — whenever it is `Secure` — carries the `__Host-`
prefix, which stops a sibling subdomain or a plain-HTTP network attacker from overwriting it.

Three clocks bound it:

| Clock | Value | Effect |
|---|---|---|
| Absolute | 7 days | hard ceiling regardless of activity |
| Idle | 12 hours | a cookie not reissued within the window is dead |
| Refresh | 15 minutes | active use reissues it, so a working session never hits the idle wall |

**Revocation is immediate.** Every account carries a `sessionVersion`; a password change, a
logout-all, enabling MFA or deleting the account bumps it, and every outstanding cookie —
and any outstanding step-up grant — dies with it. Role and team memberships are read **fresh
from the database on every request**, so a permission change takes effect on the next call, not
on the next login.

**Step-up** (`/api/iam/stepup`) covers what a session cannot: proof that the person is still
there. Creating, editing or deleting an account (role and memberships live there — it is where a
session becomes an owner), deleting a team, and changing a password each require a five-minute
grant obtained with the password or a TOTP code, presented in `X-Stepup`. It travels in a header
rather than a cookie deliberately — a cookie would ride along automatically, which is the property
being avoided.

The list is short by decision. Enrolling a machine, minting or rotating its token and registering
a repository are **not** gated: they are routine work on a growing fleet, reversible by revoking
the token they mint, and bounded by the account they belong to — while a prompt met daily is one
people learn to clear without reading, which is paid for by the three prompts that matter.
`stepup.test.ts` asserts the table exactly, so it cannot grow by accident.

Three tokens are signed with the same key over similar payloads — session, MFA challenge,
step-up grant — and only **domain separation** stops one being replayed as another. There is a
test asserting exactly that (`auth-principal.test.ts`, `stepup.test.ts`).

## 6. The controls, and what each one does not do

| Control | Does | Does **not** |
|---|---|---|
| **Exposure profile** (`exposure.ts`) | decides whether host-power routes exist at all; `public` revokes them permanently and ignores the opt-in flag; an unknown value fails closed | protect you from marking a public instance `local` — that env value is the trust anchor, which is why `doctor --exposed` re-checks against the strict bar |
| **Capability guard** (`capability-guard.ts`) | 403s `/api/exec`, `/api/chat-tty`, the whole `/api/fleet` prefix, host transcript readers and MCP admin before auth | cover a route nobody registered — an unregistered route is assumed harmless |
| **Host allowlist** (`host-allow.ts`, §4a) | 421s a `localShell` request (HTTP or WS) whose Host is not the machine's own name/address or an allowlisted origin, closing DNS rebinding | decide who may reach the port — any peer already on the LAN/tailnet passes by sending one of the machine's own names, and non-`localShell` capabilities ride no such gate |
| **Rate limiting** (`rate-limit.ts`) | 5 logins / 15 min per IP with doubling backoff; a soft per-account bucket checked before the argon2 verify | survive a process restart, or coordinate across replicas — the edge limiter is the front line |
| **Password policy** (`@agentistics/core`, re-exported by `password-policy.ts`) | 8-char floor, one uppercase, one symbol, 1024 ceiling | a length floor beats composition rules (NIST SP 800-63B) — this is a deliberate product choice, taken knowing that; there is no breach-corpus or common-password check, so `Agentistics@123!` is accepted |
| **TOTP** (`totp.ts`) | RFC 6238 second factor with single-use, hashed recovery codes | help if the authenticator device itself is compromised |
| **Session cookie** | HttpOnly, Strict, `__Host-`, three clocks, instant revocation | stop a stolen cookie being used inside its window — that is what step-up narrows |
| **Step-up** (`stepup.ts`) | requires fresh proof for destructive operations | protect non-destructive reads; a stolen cookie can still read everything in scope |
| **CSRF** (`csrf.ts`) | rejects unsafe methods that carry a cookie without same-origin provenance | apply to Bearer clients, which carry no cookie and are exempt by definition |
| **CORS** (`cors.ts`) | exact-match allowlist; no ACAO at all for an unknown origin | matter to non-browser clients, which ignore CORS entirely |
| **CSP / headers** (`security-headers.ts`) | no inline script, `frame-ancestors 'none'`, HSTS under TLS, `no-store` on `/api`, every capability denied but `microphone=(self)` | prevent an XSS — it reduces what one can do |
| **Team scoping** (`team-scope.ts`) | filters sessions, projects, caches and presence to the principal's teams plus machines they own | apply to routes that do not go through it; new data routes must opt in |
| **Audit log** (`audit.ts`) | append-only, 180-day TTL, secret-shaped fields redacted before write | prevent anything — it is how you find out |
| **Resource limits** (`limits.ts`) | byte-counted bodies abandoned mid-stream, SSE cap, outbound timeouts | bound memory used by a legitimate large aggregation |
| **Error hygiene** (`errors.ts`) | generic code + correlation ref to the client | apply to logs, which keep the full message on purpose |
| **Container** | uid 10001, read-only rootfs, `cap_drop: ALL`, no-new-privileges, loopback bind | protect the app from a compromised host |

## 7. Honest limits

- **The owner role is unbounded by design.** An owner reaches every team and every admin route.
  MFA and step-up raise the cost of using a stolen owner session; they do not cap its authority.
- **None of this has had an external audit or a penetration test.** The tests assert that the
  code does what its author intended. That is a check against anticipated mistakes, not against
  unanticipated ones.
- **A public repository does not weaken any of this** — every secret is operator-supplied at
  runtime and none is committed — but it does mean the defaults are read by attackers too, which
  is why they are the conservative ones. See [SECURITY.md](../SECURITY.md).
- **The vault does not stop malware running as you.** It closes copies of `~/.agentistics` read
  elsewhere; a process with your account, while the vault is open, can ask the protector for the key
  ([§7a](#7a-secrets-at-rest--every-secret-is-sealed-never-plain-text-under-0600)).
- **Configuration is the weakest link.** Most of these controls are switched on by an
  environment variable, and OWASP ranks security misconfiguration second among current risks.
  That is the entire reason `agentop doctor --exposed` exists and refuses to declare readiness
  on a check it could not verify.

## 7a. Secrets at rest — every secret is sealed, never plain text under 0600

**The rule:** every secret Agentistics writes is encrypted. A secret in plain text protected only by
mode `0600` is not acceptable — `0600` protects against other non-root users of the same machine
and nothing else.

**What this buys.** The threat the vault closes is **a copy of `~/.agentistics` read somewhere
else**: a backup tarball, a cloud-sync folder that swept the home directory, a pendrive, a disk
image, a stolen laptop's disk read from another OS, the Windows side of a WSL disk, a support
bundle, an agent that `cat`s the file into a transcript that is later shared. Before this, every one
of those was a live credential. Now each is a blob that opens only on this machine, under this OS
account, through its protector.

**What it does not close, in these words: a process running as you, on this machine, while the
vault is open, can ask the protector for the key** — DPAPI, an unlocked login keyring and the
Keychain all serve the same user. Malware with your account is out of scope, as it is for every
credential store on a desktop OS. The policy floor (`protectedGlobs`, and the engine's floor over the
whole data directory) keeps the native runtime's own agent away from the vault; that is the
in-product half of this limit.

### How it works

- **Envelope encryption** (`packages/vault`, public so the claim is verifiable). One 32-byte data key
  (DEK) per machine, with a random key id. It exists in plain form only in the memory of a process
  that opened the vault — never on disk, in a log, an audit event, a response or an error.
- **Per-purpose subkeys**: `HKDF-SHA256(DEK, salt = kid, info = "agentistics/vault/v1/" + purpose)`.
  A blob sealed for one purpose cannot be opened as another, which is what makes engine-api 1.5
  `secrets` safe to hand an engine: it is served `engine/…` purposes only.
- **AES-256-GCM**, a random 96-bit nonce per seal, AAD binding the blob to its purpose, its logical
  name and the vault's kid (length-prefixed, so no two tuples encode alike). Copying
  `anthropic.sealed` over `openai.sealed` fails the tag (`tampered`); a file from another machine's
  vault says so (`wrong-machine`) — "copied" and "modified" are different sentences.
- **The DEK is stored only wrapped**, in `~/.agentistics/vault/`, by the protector detection found —
  each accepted only after a real round trip, never a presence check:

| Platform | Protector |
|---|---|
| macOS | the login Keychain (`security -i`, the key on stdin) |
| Windows | DPAPI, CurrentUser (`powershell.exe`, payload on stdin; blob in `vault/dek.dpapi`) |
| WSL | Windows DPAPI through interop — verified to work from the agentop service — then libsecret, then a TPM |
| Linux | libsecret (Secret Service) first, then `systemd-creds` **with a TPM2 only** |
| none of these | a passphrase you choose — said in words, naming what was checked |

  A secret never appears in a command line (`ps` shows every argv to every user): every protector
  CLI gets it on stdin. `systemd-creds --with-key=host` is never used — a key file on the same disk is
  the rejected option below.
- **Detection runs once.** The protector is recorded in `vault.json` and never switched silently: if
  it stops answering the vault is `locked` or `protector-lost`, never quietly re-keyed (a new key
  would orphan every sealed file). `agentop vault rekey --protector <p>` is the explicit move.
- **Rejected, and recorded so it is not re-proposed:** a key derived from the machine and stored
  beside the data (machine-id, hostname, a key file in `~/.agentistics`) — everything needed to
  decrypt travels in the same tarball, so it is obfuscation; `0600` as the end state; a
  passphrase-less fallback; Windows Credential Manager; a native keychain addon.
- `0600` stays as a **second layer**: sealed files are still written `0600` in `0700` directories,
  atomically (tmp + fsync + rename + chmod + fsync of the directory), and a reader refuses a sealed
  file that is group- or world-readable, as evidence something else is wrong.

### Seeing it: Settings → Vault

`GET /api/vault` (guarded as `localShell` in `capability-guard.ts`, 404 on a central) returns metadata
only: the vault's state, its protector in plain words, the key id and creation time, and one row per
sealed file — what it is, when it was sealed (read from the file's own plain header), and whether it is
`sealed`, `pending` (plaintext still waiting) or `unreadable` (another machine's vault, not a sealed
file, or a file open to other users) with how to enter it again. It never decrypts anything, so it never
holds a value, a fragment or a fingerprint; `inventory.test.ts` plants known values and asserts their
absence. The one action, `POST /api/vault/lock`, goes through `requireVaultStepUp` (`vault/inventory.ts`),
the single place a stronger gate (authenticator, Windows Hello presence) plugs in.

### The passphrase, and a locked service

With no protector, `agentop vault init` asks for a passphrase (≥ 12 characters, not one of the
secrets it protects): `scrypt(N = 2^17, r = 8, p = 1)` → a key-encryption key → AES-256-GCM over the
DEK, parameters stored so they can be raised. Such a vault — or any vault whose protector the
service cannot reach — makes the service start **locked**: whatever needs a secret refuses with the
`locked` sentence, and nothing else is affected (metrics, the board and the dashboard keep working).
`agentop vault unlock` reads the passphrase on the terminal with no echo and hands it to the running
service over `~/.agentistics/run/vault.sock` (directory `0700`, socket `0600` — Bun has no
peer-credential call, so the uid check is the filesystem's), **never over the HTTP server**, which
binds every interface. `agentop vault lock` drops the key.

A passphrase wrapper beside the system one is optional (`agentop vault add-passphrase`); it is how a
**Docker machine** opens the vault (a container has no DPAPI or Keychain), and it is an offline
brute-force target beside the files it opens, which is why it is never the default.

### Migration, and what "securely deleted" honestly means

Every plaintext secret an earlier version wrote is migrated automatically at the first open: sealed
to a NEW file name, re-read from disk and verified, then the original is moved aside, overwritten
with random bytes, fsynced and unlinked. Each step is correct at every crash point (the state
machine is in `packages/vault/src/migrate.ts`, and a test crashes it after every single syscall).
The preferences tokens move to their sealed map FIRST and only then leave `preferences.json`, which
is now also written `0600` (it was the umask's — `0664` on the reference machine). Removing a
connection deletes its token from the sealed map in the same write; if the vault cannot open at that
moment, the id is tombstoned in `preferences.json` (`sealedTokenTombstones`, no secret) so a token
never comes back with a re-added id, and the next write with the vault open deletes it. With no protector
and no terminal, the plaintext files are left **exactly as they are** — destroying them would lose
the credentials — the service says `plaintext-pending`, and from that moment no new plaintext is
ever written: every write refuses.

**Overwrite-then-unlink is best-effort.** On SSDs (wear levelling), copy-on-write filesystems (btrfs,
APFS, ZFS), WSL's ext4-in-VHDX and anything with snapshots, the old blocks may survive. The guarantee
is "nothing is written in plain text from now on", not "the past is erased" — so the migration says,
once, that copies made before (backups, snapshots, synced folders) may still hold the secrets, and
that rotating them closes it.

A rollback to an agentop older than the vault does not know `.sealed` files: it sees no key and, if
the user re-enters one, writes plain text again. The next upgrade migrates it again. There is no
"decrypt everything back" verb; leaving the vault is `agentop vault reset` (it deletes the vault and
every sealed file after naming each) and re-entering the secrets.

**One owner per file.** The host migrates and writes S2–S6; the engine alone owns
`provider-keys/` (its layout, its writes and the migration of its legacy plaintext), and the host
never lists, migrates, scrubs or deletes anything there — `agentop vault reset` says so and leaves it.
Every migration event — `vault.migrated`, `vault.plaintext-pending`, `vault.migration-failed`, from
the host or from the engine through `host.audit` — is one line in `~/.agentistics/vault/audit.jsonl`
(0600), naming the purpose and the logical name and never a value, a length or a fragment.

### Backups

**A backup never carries the data key, wrapped or not** (`.agentistics/vault` is a `secret` row). A
restore produces a machine with no vault; the first use creates a new one, and the restore's
"omitted secrets" list is the re-entry checklist. A sealed file that travelled by other means reads
`wrong-machine`.

### A Docker central — the limit this leaves

`agentop central up` opens `central/secrets.sealed` on the HOST and passes the values to
`docker compose` through the child's **environment** (the compose file interpolates `${VAR:-}`), so
Agentistics writes no plaintext copy of its own. **But Docker persists a container's environment in
its own root-only state (`/var/lib/docker/containers/*/config.v2.json`), so on the Docker host the
central's secrets are at rest in Docker's store, readable by root and by the `docker` group (which is
root-equivalent).** Avoiding even that takes Docker/Swarm secrets or a KMS (the cloud track). A
central run without Docker under systemd should load its secrets with `LoadCredentialEncrypted=` and
a TPM2. A central started from a **repository checkout** through `central.sh` keeps its `central.env`
beside the script, where bash reads it — a developer's checkout file outside `~/.agentistics`, not
split. `agentop ci-push` reads `AGENTISTICS_CI_TOKEN` from the runner's environment and writes no
file (a test pins it).

Central-side database secrets (the persisted session secret, password hashes, TOTP seeds) are a
database-at-rest question, out of scope here.

## 7b. Ultra secure vault — presence, an authenticator code, a recovery key

§7a closes a copy of `~/.agentistics` read elsewhere. Its stated limit is that **a process running as
you, on this machine, can ask the protector for the key in silence.** The ultra secure vault attacks
that limit. It is opt-in: a banner recommends it, and `agentop vault enroll` (or Settings → Vault) turns
it on. A vault set up under §7a keeps working unchanged until you do.

> ### ⚠ Keep your 24-word recovery key. There is no second copy.
> The vault opens with **a presence device** or **the 24 words**.
> **If you lose both (a reset Windows profile or a lost key, and the paper), the secrets are gone.**
> Nobody can recover them: not Agentistics, not support, not a "forgot password" flow. You would
> re-enter them (provider keys, tokens) from their original sources. The words are shown **once**.
> Write them on paper and keep them offline. Anyone holding the words **and** this computer's disk can
> open your vault, so do not photograph them or store them in a cloud note.

### What it adds over §7a

| Layer | What it changes |
|---|---|
| **Presence** (see *Platforms* for what is available where) | The data key opens only after a human gesture. When you enrol, the silent OS wrapper is **removed** — as the setup's **very last step**, only after your recovery key is confirmed; leaving the setup earlier changes nothing and the vault keeps opening as before — and the vault gets a **new data key**: every sealed secret is re-sealed under it, so an earlier copy of the silent wrapper (a backup, a snapshot, a synced folder) opens nothing. The recovery key must follow the new key. That is why setup makes it **last**. When you turn presence on later, you type your 24 words on a terminal (`agentop vault enroll --presence`), or make **new** words (your old words then stop working). After that, the vault is locked at every service start until you confirm with your device **and** type your code (what later unlocks ask is the **unlock policy** below). |
| **Authenticator code** (TOTP, RFC 6238) | A gate on the vault's own actions, never key material: nothing is derived from the code or the seed. It applies **once you have enrolled an authenticator**. Before that, no action asks for a code. **Gated actions:** see the next table. **Replay:** a code already used is refused. **Wrong codes:** 5 pause for 30 s (doubling, capped at 15 min) and 20 freeze the gate until you use the recovery key. **The count survives a restart.** |
| **24-word recovery key** | Losing the phone or the presence device is not losing the vault. `agentop vault recover` opens it from a terminal, and then you re-enrol and receive a **new** key (the words you just typed are treated as exposed). |
| **Auto-lock** | The vault locks itself after 30 minutes without use (configurable 5–480; there is no "never"). Use means input on the Settings → Vault page, any `agentop vault` command, or any use of a secret, so a long agent run is not cut off at minute 30. Locking from a terminal on this machine never asks for a code. With presence **off**, auto-lock only drops the key from memory: the next use opens it again in silence. |
| **Process hardening** | Only the agentop service holds the key, and no vault socket or HTTP route returns a stored secret to another process: the service uses a secret on your behalf and zeroes it. On Linux/WSL the service is made non-dumpable with core dumps off; on macOS ptrace-attach is denied and core dumps are off. If that cannot be done, the vault refuses to open rather than opening unprotected. |

| Action | Code | Presence | Reuse |
|---|---|---|---|
| unlock | per the unlock policy (below) | yes (the gesture opens it; when the code is owed it must follow within 120 s, and a wrong code drops the key) | — |
| change the unlock policy | yes | yes | none, asked every time |
| list the vault, lock it from the dashboard, change auto-lock | yes | no | one code covers 5 minutes. The grant lives only in the memory of the page that typed the code and travels in a header, never in a cookie. |
| rekey, reset, add a passphrase, enrol or turn off presence, a new recovery key, replace the authenticator | yes | yes | none, asked every time |
| lock from a terminal on this machine, auto-lock, shutdown | no | no | — |

Metrics, the board and the dashboard keep working while the vault is locked; only what needs a secret
is paused.

### The unlock policy — what unlocking asks besides the gesture

Owner decision, 2026-10-02. Settings → Vault offers three modes; changing it asks for your code **and**
your gesture.

| Mode | An unlock asks | Notes |
|---|---|---|
| **Per day** (the default) | gesture + code on the **first** unlock after the computer or the agentop service starts, and once the window has expired; inside the window, re-opening after auto-lock asks the **gesture alone** | The window is **12 hours** by default (1–24, configurable), anchored to the last gesture+code unlock — a gesture-only re-open does not extend it. It lives **only in the service's memory**: a restart or reboot starts without one. It is also dropped by **any** wrong code, a recovery, a reset and a protector change (enrolling or turning off presence, a rekey). |
| **Gesture + code, always** | both, every time | The strictest. |
| **Gesture only** | the gesture alone | The code is still asked for everything else in the table above: listing the vault, settings, recovery, presence changes. |

What this trades: inside a per-day window (or always, in *gesture only*), a process running as you that
can make you approve **one** presence dialog opens the vault without the code. The code still stands
between that process and every setting, the inventory and recovery. The window never survives a restart,
so the first unlock of every boot asks for both.

**Presence prompts.** Turning presence on asks the device **twice** (create the key, then one
signature/assertion that derives the vault's key); the device check before it asks **nothing**; every
unlock asks **once**. Whether the device reproduces the key is proved by the first real unlock: a
mismatch is said in words and sent to the recovery key (`agentop vault recover`), and nothing else is
touched.

### What a page can and cannot do

The vault is driven from Settings → Vault; nobody is asked to run a command. Since v2.98.1 a reply from
`/api/vault*` never names a terminal command: every body leaves through one exit that swaps a command
for the page's own control and tells the page which button to draw (`vault/ui-sentence.ts`; a test
fails the build if a route bypasses it). The one exception is the setup code, below.

- **Only the agentop dashboard on this machine can drive the vault.** Every vault request that changes
  something must be a same-origin JSON request. A web page you happen to have open cannot send one: it
  cannot unlock, cannot keep the vault from auto-locking, and cannot use up your wrong-code allowance.
- **"A page opened on this computer" is a fact the server checks on every request** (`loopbackRequest`
  in `vault/http.ts`). All four must hold: the TCP peer is a loopback address, the `Host` header is
  `localhost` / `127.0.0.1` / `[::1]`, no proxy header (`Forwarded`, `X-Forwarded-*`, `CF-Connecting-IP`,
  …) is present, and the browser-set `Origin` is loopback too. The LAN fails the peer; a tunnel or a
  remote-access relay fails the `Host` (it names the public name) or carries a proxy header; a hostile
  site open in your browser fails the `Origin` (a browser never lets a page forge it); DNS rebinding
  fails the `Host`.
- **The first setup from a page ON this computer is proven by one presence gesture.** Before any
  authenticator exists there is no code to ask, and that is the window in which a page reaching this
  API (an XSS, a mistaken exposure) could enrol *its* authenticator and receive the first 24 words.
  Two facts now stand for "a person at this computer": the loopback request above (which removes the
  mistaken exposure) and ONE Windows Hello prompt or security-key touch, which the operating system
  draws and a script cannot answer (which removes the script). The gesture creates a throwaway
  credential and deletes it at once; nothing in the vault changes. The proof is held for that session,
  10 minutes, and honoured only on loopback requests: a proof given on this computer never stands for a
  request from the LAN.
- **The setup code is the fallback**, for a first setup from anywhere that is not this computer and
  for a machine with no Windows Hello or security key: 8 digits, 10 minutes, one use, printed only by
  `agentop vault setup-code` on a terminal, never written to a log, and each run makes a new one. It
  is deliberately not shown in the page off loopback — showing it there would defeat it.
- **Recovery with the 24 words is accepted from a page on this computer only.** The words go in ONE
  loopback request (refused before the body is read when the request is not loopback) straight into
  the same function `agentop vault recover` calls; they are never logged or echoed, their entropy is
  zeroed after use, and five wrong tries pause it for ten minutes. The session that recovered may then
  finish the re-enrolment from that same loopback page (new authenticator, personal confirmation, NEW
  words); any other session, and any request from off this computer, is refused as before. The terminal
  path is unchanged.
- **The main machine's "turn personal confirmation off"** also takes the 24 words from a loopback page
  (code + gesture still asked); off loopback the words are ignored.
- **Internal text never reaches a person.** A presence protector's reason is a key from a closed list
  (`PRESENCE_DETAILS`), translated per language; anything else — a .NET type, a sentence some tool
  printed — is replaced by "the details are in the agentop log". A test greps the Hello and security-key
  protectors for any reason that is not a key.
- **A kind that cannot be offered yet is not offered.** Security keys through Windows (the
  `webauthn.dll` bridge) are not verified on real hardware, so on Windows / WSL the page shows them as
  "coming soon" and the server refuses them in words; enrolling a kind that already protects the vault
  changes nothing, and an existing Windows Hello credential is reused, never deleted by a failed
  enrolment.

**What the loopback + gesture proof does NOT exclude:** another program running as you on this
computer can send a loopback request with any headers it likes — but that program can already reach
the vault's local socket, so the page path gives it nothing new; it still has to get *you* to approve a
Windows Hello prompt. An SSH port-forward lands on loopback too, which means it is someone who already
holds your account. An XSS inside the dashboard itself passes the loopback check; the gesture is what
stops it, and a person who approves a prompt they did not ask for is the limit stated below.

### What it does NOT stop

**In these words:** malware running as you that can modify the agentop install (its JS, its binary,
its systemd unit) can wait for your next legitimate gesture and take the key then. Presence proves a
human said "yes", not *what* they said yes to. A same-user process can also read a secret at the moment
the service uses it, if the OS lets it read the service's memory. The hardening closes that on Linux and
macOS; the list below says where it cannot. Kernel, root and administrator compromise is out of scope.

- Root or administrator, a debugger run as root, the kernel; on WSL, Windows-side administrators reading
  the VM's memory.
- **Windows native (limit):** Windows has no per-process equivalent of "non-dumpable" for a same-user,
  same-integrity caller, so a same-user process can open the service for reading
  (`PROCESS_VM_READ`). Presence keeps the key **out of memory while the vault is locked**; while it is
  **open**, a same-user reader of the service's memory gets it. Auto-lock shortens that window; it does
  not remove it. Under WSL the hardening applies to the Linux side as above.
- **A gesture you approve that malware triggered.** For Windows Hello this is lasting: the key that
  protects the vault comes from a signature Hello gives over a fixed challenge. One approved gesture
  gives malware that key for good, not only for that moment.
- **A modified agentop install** (above).
- **Typed into a page:** the 24 words of a page recovery pass through the browser and a JavaScript
  string; neither can be zeroed. The page drops them the moment the request returns.
- **Strings in memory:** JavaScript strings cannot be zeroed and the garbage collector may copy them.
  Zeroing is best-effort: every buffer the vault owns is zeroed, and a secret becomes a string only at
  the last boundary that demands one. The 24 words are never kept in memory across steps. Their buffer
  is zeroed right after the step that used them.
- **Losing both** the presence device **and** the 24 words (see the warning above).
- **No way back after enrolment:** an agentop older than this feature cannot read the vault.

### Platforms

| Platform | Presence |
|---|---|
| Windows and WSL | **Windows Hello.** Setup asks Hello **twice** (create the key, then one signature that derives the vault's key) and every unlock asks **once**; the device check before it asks nothing (`IsSupportedAsync`). Whether Hello reproduces the key is proved by the first real unlock, and a mismatch is said in words and sent to the 24-word recovery key. The dialog is owned by a small topmost window the bridge brings to the foreground, so it opens in front (the owner window taking the foreground is verified on Windows 11 build 26200 from WSL; the dialog itself awaits the owner's check). **A FIDO2 security key is not available here yet:** the Windows security-key bridge is not verified, so it is refused in words. |
| Linux desktop | **A FIDO2 security key** with `hmac-secret` (e.g. YubiKey 5), through libfido2's tools (`apt install fido2-tools`). Every open asks you to touch the key, and asks for its PIN when one is set. Not yet verified on real hardware, including the PIN prompt, which may need a terminal the background service does not have. |
| macOS | **No presence by default yet** (Touch ID is deferred): macOS stays on the Keychain wrapper of §7a, so the §7a limit still applies there. The authenticator code, recovery key, auto-lock and hardening do apply. A FIDO2 key (`brew install libfido2`) is an opt-in presence option. |
| Headless / container | None. The vault stays on its OS protector, or a passphrase where none exists; presence is reported as "not available here". |

The vault keeps one presence credential **per kind**; when it holds two kinds, either opens it. No
platform offers two kinds today, because a security key is not available on Windows/WSL yet. A vault
that also opens with a passphrase cannot turn presence on, because the new data key would leave the
passphrase behind. It is refused in words, and nothing changes.

Sleep and screen lock lock the vault **only on Linux desktops** (logind, through `gdbus`). On WSL,
Windows and macOS this is not wired yet, and the 30-minute auto-lock is what closes a forgotten vault.

### Commands

| Command | What it does |
|---|---|
| `agentop vault status` | presence, authenticator state (enrolled, failures, paused/frozen), auto-lock countdown, hardening |
| `agentop vault enroll` | runs what is still missing, in order: the authenticator (QR, then one code), presence (a device check that asks nothing, then two confirmations; the silent wrapper is removed and the data key replaced), then the recovery key **last** (shown once; three of its words typed back). If a recovery key already exists, the presence step asks for your 24 words here. Press Enter with nothing to make new words instead; your old words then stop working. `--authenticator`, `--presence <hello\|fido2>` and `--recovery` run a single step. |
| `agentop vault setup-code` | prints, on a terminal only, a new one-time code for the dashboard's first setup (never logged) |
| `agentop vault unlock` | asks the service to raise the presence prompt, then asks for your code here |
| `agentop vault lock` | locks immediately (no code needed from a local terminal) |
| `agentop vault recover` | opens with the 24 words (terminal only), then the setup steps above are owed before anything else |
| `agentop vault disable-presence` | puts the system wrapper back first, then removes the presence key. Needs your code and your gesture; on a machine marked as the owner's, also your 24 words. |
| `agentop vault rekey`, `agentop vault reset` | change the protector / wipe the vault; need your code and your gesture. If the vault's key is gone for good (the protector lost it), the terminal can reset without them. With the agentop service stopped, `reset` deletes the files directly, with only its own confirmation, because deleting needs no key. |
| `agentop vault add-passphrase` | refused where an OS protector or presence exists; the recovery key replaces it |

Every command except `reset` with the service stopped talks to the running service. None opens the
vault in its own process.

### Runner machines

A machine paired as an unattended runner will keep its runner credentials in a **separate vault**,
with its own key, that can never read your personal secrets. The storage for it exists. Pairing, the
unattended open at service start, and the `agentop vault runner` commands are **not built yet**.

## 7c. Personal secrets — the person's own passwords, logins, keys and notes

Settings → Vault protects the secrets Agentistics needs; `/vault` holds the ones the PERSON keeps
(spec: engine repo `docs/superpowers/specs/2026-10-03-vault-personal.md`). It changes no cryptography
of §7a/§7b: every record is sealed in the human scope, under the one purpose `vault/personal`.

- **Names are sealed too.** Each secret is a directory named by an opaque id, holding one sealed
  METADATA record and one sealed VALUE record per version. The disk, a backup or a future Cloud sees
  ids, sizes, version counters and times — never a name (Cloud decision C36). The sealed name binds
  each file to its id and version, so a file moved between secrets does not open.
- **The list never decrypts a value.** Only `POST /api/vault/personal/reveal` returns one; a test seals
  a marker value, drives every route, and fails if the marker appears in any other body, in
  `audit.jsonl`, on stdout/stderr, or anywhere on disk in the clear. The audit records the ACT and the
  opaque id — never the name or the value.
- **What each action asks** (rows in `VAULT_ACTION_ROWS`, every one tested server-side): listing,
  creating, groups and the `.env` import ride the 5-minute read grant (the code once). **Revealing asks
  the gesture every time** (Windows Hello) and the code too when the unlock policy is "always"; with no
  presence enrolled it asks the code, fresh; with neither it is refused. **Editing, moving to the trash
  and restoring ask the gesture fresh** (owner rule: they are dangerous). **Restoring a version and
  deleting for good ask code and gesture, fresh.**
- **Versions** are append-only (the newest 10 kept) with a version counter: an edit based on an old
  version is refused as a conflict. **The trash** keeps an item 30 days, then removes it from disk.
- **The `.env` import** sends the file text once; the server parses it, holds the pairs in memory for
  10 minutes under a single-use token bound to the session, and answers the KEYS only. A name that
  already exists is never overwritten unless the person picks "replace" (a new version).
- **Key rotation carries them**: enrolling presence re-seals every `*.sealed` under the data dir, these
  included (tested).

**Limits, stated:** a revealed value is in the browser's memory and the page's DOM for 30 seconds; a
copy is in the clipboard for 30 seconds, readable by any program of yours, and longer in a clipboard
history tool — the page says so. Names and notes are metadata: shown in the list without a gesture,
sealed at rest.

**The backup** carries the vault as ONE sealed bundle per backup (`packages/vault/src/bundle.ts`):
every sealed record still sealed, wrapped once more under a subkey of the data key so the backup shows
neither the names nor the count, plus `dek.recovery` — the data key wrapped under the 24 words — and a
`vault.json` holding only that wrapper. Nothing tied to this computer travels (no Windows Hello, DPAPI or
security-key wrapper), so on another machine the 24 words are the only way in; a restore lands in
recovery mode (new authenticator, personal confirmation, new words). The bundle sits beside the archive
and, on GitHub, is a second asset of the same release. **A backup is not a deletion:** older releases keep
older bundles — ciphertext under the key of their time. After a data-key rotation, the next confirmed
upload erases this machine's older bundle assets by itself; "Erase the vault's history in the backup" on
the vault page does it on demand (code + Windows Hello). Restoring never applies a bundle over a vault that
holds secrets; an empty first-use vault is set aside (renamed, not deleted). Tested end to end on a fresh
data dir: personal secrets and the GitHub token come back with the 24 words, and nothing else opens them.
**Limit:** a release deleted by hand outside agentop, or a copy of an archive made elsewhere, is outside
what the wipe can reach.

**Agents use a secret without seeing it** (spec §8). The person picks credentials or groups with the
`:vault` chip in a session's composer; sending GRANTS exactly those to that session — the gesture,
fresh — and the message carries `vault://` references plus a briefing, never a value. A grant lives in
memory only, dies when the vault locks or the person revokes it, and holds ids and reference names.
- **Native sessions** (the engine, engine-api 1.7 `vaultRefs`): after the policy allows a tool call, the
  session's granted values reach THAT call's process as `VAULT_<KEY>` env (a shell call carrying them
  runs in its own bash, never the shared one), and every tool output is scrubbed before the content
  store, the history, the journal, the stream or the model sees it.
- **Claude Code** (hooks, installed by `agentop hooks install`): `PreToolUse` rewrites a granted
  `vault://key` in a Bash command into `$(agentop vault ref key)`, which fetches the value over
  `vault.sock` when the command runs — the one op that returns a personal value, only for a granted
  reference, audited per use; `PostToolUse` replaces every tool output through the scrubber.
  **Unverified:** the Claude Code docs do not say whether the transcript JSONL keeps the hook-replaced
  output or the original; treat the on-disk transcript as possibly holding the value.
- **Other harnesses**: no hook to rewrite or scrub — only the copies agentop SERVES are scrubbed.
- **Every copy agentop serves** of a granted session — chat turns, pending prompts, terminal frames, the
  fleet's tails — has the value and its base64 / url / hex forms replaced by `«vault:NAME»`.

**What scrubbing is NOT:** containment. A process that holds the value can print it in pieces, encode
it twice, hash it, or send it over the network; scrubbing stops the accidental exposure (a program
printing its config, `env`, `curl -v`, an error that echoes a key), not a determined exfiltration. A
value shorter than 6 characters is not scrubbed (it would blank ordinary words). The session id a hook
uses is a non-secret env var set at spawn; another process running as the user could claim it — the
same-user limit of SECRETS.4 §0, and every use is audited.

**The phone** (spec §7). A request that is not loopback never makes the service raise Windows Hello
for a personal-secret action — a prompt on an empty desk, approved later by whoever sits down, is the
worst of both. The phone proves the gesture with a **passkey** (WebAuthn, `userVerification:
required`), verified by the service with no third-party library (`packages/vault/src/webauthn.ts`,
ES256/RS256; refuses at the first failed check: challenge, origin, rpId, UP/UV, signature, a counter that
does not move forward). A verified assertion mints a **gesture token: 60 s, single use, bound to the
session and to exactly one action on one target** — a reveal of one field cannot edit anything.
**Registering** a phone is an escalation in two halves on two devices: the phone asks with the code (the
vault open), a pending request with a two-number match code appears on the computer, and the person
approves it there with Windows Hello (loopback only, gate row `phone-enrol-approve`). The approval is
single use, bound to the phone's session and kind, and expires in five minutes, so a stolen code alone
enrols nothing. The passkeys live in a sealed record, so a plain file write cannot add one. WebAuthn needs a secure context:
over plain `http://` the page says how to get an https address instead of offering something that cannot
work. The owner's alternative, **"accept my code on the phone"**, is off by default, turned on only from
the computer (code + Windows Hello), and opens a **30-second reveal window** per fresh code — reveals
only; editing and deleting from the phone always need the passkey. Over plain http that option sends the
code and the value unencrypted on the local network, and the switch says so.

**Opening the vault from the phone** (spec §10). Once presence is enrolled every silent wrapper is
retired, so a locked vault opens only with Windows Hello, a security key or the 24 words — none of which a
phone can give — and `POST /api/vault/unlock` now REFUSES off loopback instead of raising Hello on an
empty desk. A phone therefore gets a copy of the data key of its own, and the secret behind it lives ON
THE PHONE, never on the computer (`packages/vault/src/phone-wrap.ts`, `vault/phone-unlock.json`, 0600,
holding ids, the kid, salts, ciphertext and a passkey's PUBLIC key — no label, no secret):
- **Passkey**: the WebAuthn **PRF** extension turns a per-copy salt into 32 bytes only after the phone's
  biometrics; that is the KEK. Opening = a verified assertion (fresh challenge, origin, rpId, UV, counter)
  carrying the PRF output, PLUS the authenticator code. A phone without PRF keeps its passkey for
  confirming actions and is told, in a sentence, that it cannot open a locked vault.
- **Device key** (only while "code alone from the phone" is on): 32 random bytes handed to the phone's
  browser once, at approval. Opening = that key PLUS the code. Turning the switch off deletes every
  device copy and forgets the devices.
In both cases the code is asked BEFORE anything is unwrapped and checked by the same `completeUnlock`
the computer uses, with the unwrapped key — so the phone's unlock lands in the same auto-lock window, a
wrong code zeroes the key, the freeze counts it, and it is audited as `vault.unlock` with `device` (the
owner's label for that phone). A copy someone writes into the file with a key of their own opens nothing
real: the key it yields must then open the authenticator seed sealed under the REAL key before anything
is adopted. A data-key rotation leaves every phone copy stale (it cannot be re-wrapped: the computer does
not hold the phone's secret); the page says those phones must be approved again and offers to clear
them. **Stated limit**: the device key sits in the phone browser's storage, so anyone who can run script
on the Agentistics origin in that browser can read it — the same reach that could already drive the page.

## 8. Per-connection sharing rules — the guarantee, stated precisely

A member can restrict what each central connection receives, across **two dimensions** —
repository (`git_remote`) and project (`project_path`) — under one of **two modes**
(`share-rules.ts`, `team-rules.ts`, `team-forget-client.ts` — see
[architecture.md](architecture.md#per-connection-repository-sharing) for how it works):

- **`denylist`** ("share everything except…") — the default, and the same behaviour every
  existing `deniedRepos` config had before this shipped.
- **`allowlist`** ("share only…") — nothing reaches this central unless it matches a listed
  repo or project.

The typed rule list (`TeamConnection.sources: ShareSource[]`, plus `shareMode`) exists in exactly
three places — `~/.agentistics/preferences.json`, the in-memory `TeamConnection` on the member, and
the browser tab talking to that machine's own origin — and appears in **no** request body sent to
a central: `IngestBody` is unchanged, and `GET /api/team/status` exposes only `shareMode` and a
per-dimension **count** (`deniedRepos`/`deniedProjects`, or `allowedCount` in allowlist mode) —
never the values, same-origin only.

**What is guaranteed:** a central never learns *which* repositories or projects are hidden (or
allowed), nor how many, nor their names, sessions, prompts, titles, models or cost — **provided
that data was never pushed to it and had no activity before the attribution boundary.** This holds
identically in both modes: allowlist mode does not disclose the *complement* of what it shares
either — a central sees only what was let through, never a hint of what else exists.

**Allowlist mode is the safer default to choose for an untrusted central**, specifically because
of how it treats the unknown: a repository or project that appears on the machine *after* the rule
was set is **hidden** under allowlist (it matches nothing, so it is not shared) but **shared** under
denylist (it matches no *block*, so it goes through). Denylist requires the user to notice and add
every new thing they want hidden; allowlist requires them to notice and add every new thing they
want shared. For a central the user does not fully trust, the fail-closed direction is the one
where forgetting to update the rules leaks nothing new.

**One thing "share only…" must not be read as promising, and the UI must say so explicitly:
allowlist mode still ships the prehistory rollup.** Work done at or before Claude's own
`lastComputedDate` summarisation watermark cannot be decomposed by repository or project by
*anyone*, including this machine — the consolidate store is a strict subset of what Claude already
rolled up into `stats-cache.json`, and there is no per-session record left to filter. That block
travels to every connection, allowlist or denylist, as unattributed daily volume (tokens, cost,
session/message counts with no repo, no project, no session id, no prompt attached) — exactly as it
does today under a denylist. Choosing "share only project X" narrows everything *decomposable*, not
that rollup; the existing `prehistorySessions` marker (surfaced in the confirm modal and the read
view) reports its size so the user can judge how much of their history that covers. A stronger-
sounding mode name must never imply a stronger guarantee than the attribution boundary allows.

**What is NOT guaranteed, and must be said in the UI — do not present this feature as stronger
than this:**

1. **A repo that was already pushed is disclosed by its removal.** The central holds those
   documents with `git_remote`, `project_path`, `first_prompt`, `title`, `model`, tokens and cost,
   and the forget request names them by id. Deleting data you have already handed over is
   inherently observable — the strong promise above applies only to repos that were *never*
   shared with that central; the weak one applies to repos that were.
2. **Work done before the attribution boundary rides inside the prehistory block** as unattributed
   daily volume — no repo, no project, no session, no prompt attached to it — and **no later rule
   can withdraw it**, because there is no document left to name.
3. **The existence of a filter is observable.** A restricted machine's session documents stop
   covering its own filtered days, and a scoped delete is visible on the central's change stream.
   This is inherent to withholding data; there is no marker field creating it.
4. **Colluding centrals can reconstruct each other's denied set.** Two centrals (or one operator
   with accounts on both) seeing the same machine, with overlapping presence windows and
   overlapping shared-session sets, can take a set difference and recover the other's rules.
   Per-connection restrictions are confidential against a *single* central operator, not against
   collusion between them.
5. **CI ingest and the OpenTelemetry exporter are outside these rules entirely, in either mode.**
   A connection's sharing rules are a *member push* rule; they do not reach `agentop ci-push` (CI
   sessions are stamped server-side under a different `memberId`, keyed by repo) or
   `otel-watcher.ts`'s OTLP export. Blocking (or failing to allowlist) a repo on a member
   connection does not stop that repo's GitHub Actions runs or OTel metrics from reaching the same
   central by a different path.

### 8.0a What a shared session document carries — the compaction figures and the skill names

`TeamSessionDoc` is `Omit<SessionMeta, …>`, so a field added to `SessionMeta` travels to a central
by default and is stored in Mongo. Two were added with the behaviour baseline
(`packages/core/src/session-profile.ts`) and the decision is recorded here rather than left to be
discovered later:

- **`compact_count` / `compact_ms` / `compact_dropped_tokens`** — counts and durations. They carry
  no text and describe the *shape* of a conversation, exactly as `user_message_count` and
  `tool_errors` already do. Shared.
- **`skill_uses`** — a map of skill NAME to a count (`superpowers:brainstorming: 2`). This is the
  one that needed a decision, because a skill name can be private: a skill is a file in
  `~/.claude/skills/` or a plugin, and a house style names them after internal systems
  (`acme-deploy:rollback`). It is **not** free text and not chat — it cannot carry a pasted
  credential, which is what `redactSecrets` exists for — but it does name a tool the user chose to
  install.

**The judgement: shared, and bounded by the same rules as everything else.** A skill name is
metadata about the machine's own tooling, of the same order as `model`, `languages` and the tool
names already in `tool_counts` — which have always travelled and which name MCP servers
(`mcp__<server>__<tool>`) with the same specificity. It is subject to the per-connection sharing
rules like any other part of the session: a session in a withheld repository or project does not
reach that central at all, so a project's skills go with it. **Nothing on the central reads either
field** — no view, aggregate or export shows them today; they travel because the document is
whole, and they are there for a machine's own profile if the surface ever moves.

**If that is the wrong trade for a deployment, the lever is the sharing rules, not a redactor.**
`redactSecrets` is deliberately precise and value-shaped (see the team-mode rules in CLAUDE.md); a
rule that ate skill names would be a rule about a field, which is a different mechanism and would
have to be a declared per-connection option rather than a silent scrub.

### 8.0b The delivery board — free text, per task, off by default

The board (`/tasks`) is the one thing a member pushes that is **free text by design**: a title, a
description somebody wrote out, every comment, the subtasks, the names of the files attached to a
card. So it travels under a second, narrower gate than everything else:

- **`Task.shared`, absent reading as NOT shared.** This is deliberately *not* the `shareMode`
  migration rule (where absence reads as denylist, i.e. share) — it is the strict opt-in reading.
  There, treating absence as anything else would silently invert live sharing rules; here, it
  would publish text nobody offered. There is no "share everything" switch, which would be the
  lenient default by another door. A board is opted in one delivery at a time, by its owner, from
  the delivery's own screen or `agentop task share <ref>`.
- **The connection's rules still bind the sessions, unchanged.** Sharing a delivery adds its own
  record to what already travels; it can never widen a repository or project rule. A shared task
  whose work sits in a withheld repository ships its record and **none** of its sessions — and the
  central is told how many are missing (`sessionsWithheld`), so the delivery reads as *measured
  short* rather than as one that cost less.
- **The text is redacted at BOTH boundaries** — `redactSharedTask` on the member before the push,
  and again in `toTeamTaskDoc` on the central at ingest. The second pass is not belt-and-braces: a
  central cannot assume its members run current code, and in a mixed-version fleet the machine
  still on the old build is exactly the one that leaks. The redactor is the same precise, never
  exhaustive one `first_prompt` goes through, with the same limit: it is a safety net for the
  accidental paste, never a substitute for rotating a leaked credential.
- **File BYTES do not travel.** The central learns that a delivery has N files and what they are
  called; fetching one would be an on-demand pull over the reverse channel, the way raw chat
  already works, and does not exist yet.
- **No number computed on the member travels.** Cost, rounds and tokens are resolved on the
  central by the same `task-rollup.ts` the machine's own board uses, over the sessions it already
  holds. A total shipped from the member would be a second answer to "what did this cost".
- **The claim does not travel.** A 30-minute lease pushed on a seconds-to-minutes cadence arrives
  stale and would read as "somebody is working on this right now" long after they stopped.
- **A revoke or a `leave` takes the boards with it** (`deleteMemberTasks`), like the sessions and
  the workflow runs: text shared under a relationship does not outlive it.
- **The central's board is read-only.** `GET /api/team/tasks` is authenticated like every other
  team route and there is no write path: the record lives on the machine that owns it.
- **It is scoped to the VIEWER by the rule `/api/data` already applies** — an owner sees every
  machine; anyone else sees the machines of the teams they MANAGE (`dataTeamIdsOf`; belonging is
  not reading) plus the machines they own, so a loose machine is still visible to its owner. A
  machine outside that scope is not filtered out of the answer, it is never built into it, so no
  title of theirs can reach the viewer through any field. A machine the roster cannot attribute (a
  revoked or legacy identity carries no team) is withheld from a scoped viewer and shown to an
  owner — fail closed. This is deliberately not a new visibility model: a second answer to "who may
  read this" is a second place for it to be answered differently.
- **A delivery may only ever name its OWN machine's sessions.** `sessionIds` arrives from the
  member, so the central resolves each id against that machine's sessions and counts anything else
  as MISSING. Without that check a machine could list a neighbour's session id and have the central
  resolve that session's cost, tokens, harness and repository under its own delivery — reading a
  colleague's numbers back off its own board. The ids are UUIDs and so not guessable, which makes
  it hard rather than impossible; the check makes it neither.

What is NOT guaranteed here is everything §8 already lists — in particular, **a delivery already
pushed is disclosed by its removal**, exactly as a repository is. Turning sharing off stops future
pushes; withdrawing what a central already holds is the observable delete described above.

### 8.1 Rules are per machine, and how a machine finds out

Sharing rules live on the machine that declares them. Restricting a repository on one laptop does
nothing on a second laptop signed in to the same account, which will keep pushing it.

A machine detects that situation **without disclosing anything**. It calls
`GET /api/team/account-repos`, which returns the distinct repositories the central holds *for the
caller's own account* and which of that account's machines pushed each one. The request names no
repository and carries no rule — it is byte-identical whether the caller just restricted something
or is idly refreshing — and the response is data the account already owns and can already read from
its dashboard. The comparison against the private rules happens **on the machine**
(`server/account-repos.ts`, `findStillShared`); the central never learns the outcome. The result is
the orange banner on the connection card naming the repository and the sibling machine.

Scope: the route is minted-token-only and scoped to the token's **owner accounts**
(`listSiblingMachines`), never by team and never globally — a token with no owner account sees only
itself. CI and repo tokens are excluded.

### 8.2 The sealed envelope — telling the other machines, through a central that cannot read it

§8.1 lets a machine *detect* the problem. Telling the account's OTHER machines is the opposite
direction, and it cannot be done without something crossing the central. So it crosses encrypted.

**Construction** (`envelope-crypto.ts`, composed from standard primitives, nothing invented):

```
E            = fresh X25519 keypair, one per message
dh1          = X25519(E.priv,      recipient.pub)     confidentiality + freshness
dh2          = X25519(sender.priv, recipient.pub)     sender authenticity
key          = HKDF-SHA256(ikm = dh1 ‖ dh2, salt = E.pub ‖ recipient.pub, info = header)
ciphertext   = AES-256-GCM(key, random 12-byte iv, aad = the full header)
```

This is the Noise `X` / X3DH-style composition. The ephemeral DH means the same rule set never
seals to the same bytes twice. The static-static DH is the **authenticator**: only a holder of the
sender's private key can produce a `dh2` the recipient reproduces. A signature was rejected
deliberately — it would prove authorship to anyone who ever obtained the plaintext, whereas the DH
authenticator is verifiable only by the intended recipient, and two machines of one account need no
transferable proof of what they told each other. The whole header is the GCM AAD, so the central
cannot re-address, relabel or re-date an envelope it relays.

**The recipient checks the header it authenticated.** Binding sender, recipient, instance and time
into the AAD proves the central cannot *rewrite* them; it says nothing about the central *choosing*
the routing fields it reports beside the ciphertext. `open()` therefore requires the caller to state
the sender the transport claimed, this machine's own id, and the connection's instanceId, and
refuses on any disagreement **before** any key agreement. The sender's pin is looked up by the id
**inside the seal**, never the one supplied beside it. Without this, a central could publish a
directory entry under a machine id it invented pointing at a real peer's key, then relay that peer's
genuine envelopes under the invented identity: pin matches, GCM verifies, and the proposal is filed
as authored by a machine that does not exist under a display name the central chose.

**Replay is refused by memory, not by freshness alone.** Every opened envelope's digest — SHA-256 of
`ciphertext ‖ tag`, never the central's own envelope id, which it mints and can vary — is persisted
in the inbox and **is not cleared by dismissing a proposal**. Ignoring a proposal is therefore
permanent. Without it, a pre-restriction envelope (`denylist` with no sources = share everything)
could be replayed after the sender tightened up, offering the user a one-click downgrade.
`createdAt` is additionally bounded (`ENVELOPE_FRESH_MS`, 7 days, with an hour of clock skew) as the
backstop against a central withholding an envelope and delivering it much later. Days rather than
minutes is deliberate: the mailbox exists *because* peers are offline, so a minutes-wide window
would drop exactly the messages the channel was built to deliver. The card also renders the
proposal's age and calls out anything over a day old.

**Key distribution and its honest limit.** Each machine generates its keypair locally and publishes
only the public half (`POST /api/team/keys`, authenticated by its existing minted token). Nothing to
type, working the moment a second machine joins — which is what the product required.

> **A central that publishes a public key it controls, under any machine id, reads that channel.**
> This is not a narrow first-sight race. The central does not need to *substitute* an existing key:
> it can simply **invent a machine** at any time under a key it holds. A peer that never existed has
> no prior key to contradict, so trust-on-first-use accepts it, and from that moment every
> restriction message is encrypted to the central as well as to the real siblings. No fully
> automatic scheme closes this: two parties whose only channel is the adversary cannot bootstrap a
> secret without a pre-shared secret or out-of-band verification.

What is done instead — the point of every item below is that trust can be established
automatically, but never **silently**:

- **Pin on first sight.** The first time B sees A's key it stores it (`envelope-keys.ts`). If it
  ever changes, B **refuses to decrypt** — it does not guess between a reinstall and an attack —
  raises a red alarm on the connection card and a `member.peer_key_changed` notification, and
  **leaves the envelope on the central** so resolving the key does not cost the message. A sender
  likewise refuses to seal *to* a changed key. The pin is per connection: the same machine id on two
  centrals is two different machines.
- **A sender must be in the directory.** An envelope from a machine the key directory did not just
  list is refused outright, pinned or not. This closes the cheaper twin of the fabricated-peer
  attack: rather than *publishing* a peer (which is announced, below), a central can *omit* one and
  seal under an id it invented — no directory entry means no pin, and an unpinned sender would
  otherwise skip the pin comparison entirely and be filed as an apply-ready proposal with no
  notification at all. There is no legitimate race, because a sender publishes its own key before
  it deposits.
- **Announce every new pin.** The first time a peer is pinned — including a fabricated one — the
  connection card and a `member.peer_pinned` notification name it: "a new machine of your account
  will now receive your sharing rules". Same alarm class as a changed key. Silent
  trust-establishment *is* the exposure, so this is the mitigation for the limit above, not a
  nicety.
- **Show the fingerprints.** The expanded connection card lists this machine's own fingerprint and
  every pinned peer's, so a user who cares can compare two machines they own. Never required.
- **One bad key cannot disable the channel.** A directory entry whose key cannot be used is skipped
  and counted, not thrown — an unguarded `seal()` in the peer loop would have let a central publish
  one junk key and silently stop every sibling from ever being told anything.

**What the central inevitably learns, and this is not implied away:** that a machine deposited a
sealed envelope, when, for whom, and how big it was. Since the channel carries only rule changes,
"an envelope exists" ≈ "that machine changed its rules" — which the scoped delete
(`POST /api/team/forget`) arriving at the same instant already reveals, so it concedes nothing new.
It does **not** reveal which repository, in which direction, or whether the peer acted on it.

**Propose, never apply.** A decrypted message NEVER changes the receiving machine's rules. It is
stored as a proposal (`envelope-inbox.ts`), raises a notification, and waits for an explicit click
that runs the ordinary `PATCH /api/team/connections/:id` — the same validated path a hand-edited
rule takes. There is no apply endpoint anywhere on the server, and `envelope-client.test.ts` asserts
that the inbox module exposes no such function: a machine that silently reconfigures another
because a message arrived would be a remote-control channel, and this is not one.

**One keypair per machine, not per central.** A machine publishes the same public key to every
central it connects to, so two centrals comparing notes can confirm they are looking at the same
physical machine. That is accepted rather than fixed: the machine already presents the same
`git_remote` set and the same statsCache shape to both, so per-connection keys would not make it
unlinkable, only harder to reason about. An envelope still cannot cross centrals — the instanceId is
bound into the AAD and re-checked on arrival.

**Mailbox scoping.** Deposit/fetch/ack are minted-token-only. The SENDER is stamped from the token,
never read from the body; the RECIPIENT must be a machine of the caller's own account
(`allowedRecipients`), so the mailbox is not a write primitive against strangers; a refused
recipient is silently skipped rather than named, because naming it would answer "does this machine
belong to my account". Retention is bounded by age (in step with the recipient's freshness window) and per-recipient
count, and revoking a machine's token drops its published key and all of its mail. The private key
never leaves the machine, never enters a log, an audit event or any response body.

**Rotating a token is a change of identity, and is treated as one.** `memberId = sha256(token)`, so
rotation renames the machine in every collection keyed by that id. `rotateToken` carries the
history across — sessions, memberStats, workflows, the tags pinned to the machine, and the
published envelope key — and the enumeration of what is keyed by a machine id lives in
`rotate-identity.ts`. Two things it deliberately does **not** do:

- **It never re-addresses a sealed envelope.** The whole header is the GCM AAD and `open` compares
  every routing field against what the transport claimed. Mail addressed to the old id therefore
  yields `recipient_mismatch` no matter who relays it, so it is **deleted** rather than left to
  expire (the audit event reports the count — it is a loss, not a move). Mail *sent* by the old id
  still opens exactly as sealed and is left untouched; re-stamping its sender would turn a true,
  deliverable announcement into `sender_mismatch`. The loss is bounded: every message is a full
  snapshot that its sender re-announces on its next rules change, and facts already collected live
  in the machine's own inbox and survive.
- **It never carries a sibling's pin across.** To a sibling the rotated machine is a machine it has
  never seen: it pins on first sight and **announces** it, exactly as above. Continuity cannot be
  established here without a claim the central could forge — a "formerly `<oldId>`" field is a
  central assertion by construction, and "the key is the same, so the machine is the same" is no
  better, because a public key is public: a central can list an invented machine carrying a key it
  copied from a real one, and treating a familiar key as proof of continuity would let it suppress
  the very announcement that defends against fabricated peers. A sound proof exists in principle
  (the old private key signing the new id) but rotation is initiated on the central and the machine
  learns its new id only afterwards, so it cannot sign it in advance. The rotation dialog says the
  siblings will see a new machine instead of implying they will not.
`GET /api/team/proposals` returns a sibling's full source list, so it is registered in
`capability-guard.ts` and is unreachable on an internet-exposed instance.

## 8b. The fleet routes — starting an assistant is the strongest thing this server does

`/api/fleet` and everything under it is host power under another name. Reading the fleet CAPTURES
each live session's screen — a coding assistant's terminal, transcript and all. `/api/fleet/act`
types into it, answers a permission prompt for it, or kills it. `/api/fleet/stream` streams that
screen continuously. `/api/fleet/attach` hands out the command that ENTERS it. And
`/api/fleet/input` sends RAW KEYSTROKES into a live one, and
`/api/fleet/new` **starts a fresh coding assistant, with a prompt, in a directory the request
names** — billable, on this machine, with whatever access the assistant itself has.

Three things bound it, and only one of them is wording:

1. **`localShell`, registered as a PREFIX.** The whole `/api/fleet` subtree maps to `localShell` in
   `capability-guard.ts`, so it is 403 on a `lan` or `public` profile *before* the auth gate,
   whoever is authenticated. It is a prefix and not five names on purpose: a route that is not
   registered is assumed harmless, so the next fleet route someone adds must be guarded by having
   been added at all, never by having remembered a second table. `capability-guard.test.ts` asserts
   a path nobody has written yet resolves to `localShell`, and that a near-miss (`/api/fleetwide`)
   does not.
2. **404 on a central.** A central aggregates many machines and hosts none of their sessions, so a
   fleet read there would be that box's own processes answering under someone else's page. The
   guard is a prefix too, for the same reason.
3. **What a start request may ask for** (`fleet-spawn.ts`, pure and tested). The directory must be
   ABSOLUTE — a relative path resolves against the server's own working directory, so the session
   would open somewhere nobody named. The harness must be one this machine can start. An `effort`
   must be in the closed enum the CLI itself prints. Nothing is repaired: a request naming a model
   on a harness with no model flag is refused, because a session that is not the one asked for is
   worse than no session.

`POST /api/fleet/new` is the one fleet call that takes a directory from the request body.
`resume` deliberately refuses to — reopening names an existing conversation, so a directory in the
body could only ever contradict it, and accepting one would let a caller start an assistant
anywhere on this machine. Starting IS the act of choosing where work happens and has nothing else
to read it from; that is why the bound above is exposure rather than argument.

`GET /api/fleet/attach` returns a ticket (`argv` + the real detach key) and never attaches: the
server has no tty. It checks SCOPE first — the row must be one this machine manages and must be
running — because `attachSession` composes the command from whatever id it is given without asking
whether that session exists.

**Raw keystrokes.** `POST /api/fleet/input` types characters with no submit, or presses one named
key, in a session this machine manages. It is the same power a terminal has once attached, reached
through the same `localShell` gate and the same scope check, and its one rule is in the pure
`fleet-input.ts`: a key name outside tmux's own vocabulary is REFUSED, never forwarded, because
`send-keys` does not fail cleanly on an unknown name — it sends the string, so a bogus key becomes
typed text in somebody's live session. Unlike `prompt` it does not refuse an open dialog: a KEY is
what answers a dialog, and the caller is looking at the frame while they press it.

**Framing.** On a `local` profile the dashboard now allows exactly one frame-ancestor,
`vscode-webview:`, so the VS Code extension can show it in an editor tab; `X-Frame-Options` is
omitted on that profile because `DENY` cannot express "one scheme" and would simply win. A web
page's origin is `http:` or `https:` and cannot be forged into another scheme, so no page gains the
ability to frame anything, and `lan` / `public` are untouched — they keep `frame-ancestors 'none'`
and the legacy header. `security-headers.test.ts` pins both directions.

The Studio's MEDIA responses (`/api/fleet/media`, `/api/fleet/tree/media`) are the one exception to
`frame-ancestors 'none'`, because the Studio shows a PDF in an `<iframe>` of the dashboard itself.
They carry `default-src 'none'; sandbox; frame-ancestors 'self'` (plus `vscode-webview:` on `local`)
and, where the profile does not embed, `X-Frame-Options: SAMEORIGIN` — never `ALLOW`, never absent
off `local`. Measured in Chromium: the same origin renders the PDF, a foreign origin is refused with a
`frame-ancestors` violation. `applyBaselineHeaders` (`response-policy.ts`) is the one function that
composes this and `index.ts` calls it; `response-policy.test.ts` tests that function, not a copy.

## 8c. Managing a machine's sessions from a central — what is guaranteed, and what is not

Reaching into another machine's live sessions is the most powerful thing a central can be asked to
relay. Four things make it safe enough to offer, and one thing it explicitly does not promise.

**It is off until the machine turns it on.** Absent consent reads as OFF — the strict opt-in
reading, and deliberately not the `shareMode` migration rule that treats absence as the old default.
(The dashboard's own switches no longer share that reading: since 2026-09-14 an absent
`shellEnabled`/`editorEnabled` reads as ON, and since 2026-09-29 so does `chatEnabled` (owner
decision, `chat-gate.ts`), because they are standing entries
of the session's own bottom bar — see `shell-gate.ts`. That reversal is about a switch on the
machine's OWN dashboard; relaying a machine's sessions to a CENTRAL is a different grant and keeps
the strict reading.) Treating absence as ON here would hand every already-connected
machine to its central on upgrade.

**Only the machine's OWN accounts.** `machineOwnedBy` (`iam-view.ts`) is deliberately narrower than
the `canManageMachine` that governs renaming, rotating and re-assigning a machine: administering a
machine belongs to whoever runs the instance, reaching into its live sessions belongs to its user.
An instance owner who is not this machine's account is refused, and gets the same `not-owner`
answer as a stranger — so the route is not an oracle for which machines a central holds.

**The screen and the conversation never travel.** The relayed row is built by an ALLOWLIST of keys
(`reduceMachineFleetRow`), so `lastLines`, `chatTurns`, `approvalLines` and `dialogOptions` cannot
cross even as a future field somebody adds to `ControlSession`. `machineFleet.test.ts` feeds a row
carrying all of them and asserts none survives. This is what keeps the 410 on
`GET /api/team/session-chat` meaningful.

**`approve` and `prompt` are refused, and not merely disabled.** Neither can be offered honestly
without the screen: a permission prompt is `1. Yes / 2. Yes, always / 3. No`, an `AskUserQuestion`
can offer five answers that do different work, and a keystroke that answers cannot know which
option it is taking. A button over a dialog nobody can read is the accident `parseDialogOptions`
exists to prevent.

**The machine is the authority, not the central.** Consent, the verb allowlist **and this
connection's sharing rules** are re-read on the member on every request. The central's copy of
those checks exists only to spare a round trip and answer the user instantly; a check that runs
only on the party whose behaviour cannot be verified is not a check.

**A withheld session cannot be acted on, and for one release it could be.** The two consent
switches are machine-wide: they say whether sessions may be managed at all, and nothing about
WHICH. The rules in §8 say which. Both must hold, and only the first one did — the read half
filtered rows through `cwdShared` while the act half resolved the id against the machine's raw
fleet, so a central could `kill`, `rename`, `resume` or re-task a session in a repository its
member had explicitly withheld from it. A rule enforced when you look and not when you act is not
a rule. `performMachineAction` now resolves the target through the same predicate the rows went
through, and refuses an id it cannot resolve — an unresolvable target has no directory to judge,
and passing it through would leave every verb reachable by naming an id the fleet does not list.

**The task verbs no longer exist.** `openTask` acted on the piece of WORK a row was filed under,
expanding across the whole registry, and a task routinely spans repositories — so on a restricted
connection it reached sessions the central was never shown, started assistants in their directories
and reported how many. It was refused for every restricted connection rather than only when a task
provably spanned a withheld row, because the narrower check answers, one visible row at a time,
"does this one share work with the hidden half" — an oracle, and the same correlation §8 exists to
deny.

Both `openTask` and `finishTask` are now absent from `FleetActionId` and from
`REMOTE_SCREENLESS_ACTIONS`. That list is CLOSED — an action it does not name is refused — so the
protection is structural rather than guarded, and it applies to an unrestricted connection too,
which the old guard never covered. Finishing a delivery is asked when its session is stopped, on
the machine, and written through the board's own API; reopening a whole task is `agentop session
open`. **A future verb whose subject is a TASK rather than a ROW must restore that refusal before
it joins the list.**

**The stated non-guarantee.** Whoever runs the central administers machines and can re-assign one
to another account. This switch is what stops session access being on without its owner choosing
it — it is **not** a lock against a hostile central operator, and no surface claims otherwise: the
confirmation dialog says so before the switch is turned on. A guarantee that hides its own edge is
the kind people stop believing the first time they find the edge themselves.

Everything relayed is audited on the central (`machine.session_action`, its own action rather than
a flavour of `machine.update`, so an audit can answer "who killed my session") and announced on the
machine itself — an action invisible on the machine it happened to is the failure this feature has
to avoid. The session id is recorded and the text never is: a rename or a note is the user's own
words about their own work.

## Keeping engine code off the public repository

The engine (`agentistics/agentistics-engine`) is the source of truth for the paths in
`.github/frozen-engine-paths.txt` plus the engine layout (`engine/src/`, `runtime/src/`,
`engine/test/`, `public.pin`; `engine.pin` is allowed). Three layers, only the first of which
*prevents* anything:

1. **Local `pre-push` hook** (`.husky/pre-push` → `packages/server/scripts/push-guard.ts`). Refuses a
   push whose range adds or modifies those paths, whose clone has a remote pointing at the engine repo,
   or that carries a commit present on the engine's `origin/main` but not on the public `main` (skipped
   when `~/agentistics-engine` is absent, e.g. a contributor). Quiet on success; on failure it prints the
   offending paths/commits, capped at 20 lines. `--no-verify` bypasses it.
2. **The CI `frozen-paths` job** guards pull requests (the `[ES.4]` delete-only exception applies there).
3. **`engine-leak-detection.yml`** runs on a push to *any* branch: the job goes red and ONE issue per branch
   (label `security`, assigned to the owner) is opened or commented on. This is **detection, not
   prevention**: the code is already on the remote when it fires.

**Limitation, stated rather than papered over.** GitHub push rulesets ("restrict file paths") cannot be used
here: creating one on `agentistics/agentistics` fails with `422 Source public repos cannot have push rules`
(the org is on the free plan, and the API refuses push rules on a public repository). `main` and `dev` keep
branch protection; new branches are covered only by the layers above. `scripts/check-public-branches.sh`
audits every remote branch after the fact.

## 9. Verifying it yourself

Each control has tests next to it; these are the ones worth reading first:

| Question | Test |
|---|---|
| Can a route become public by accident? | `authz-gate.test.ts` — asserts the exact `AUTH_PUBLIC` set |
| Can a low-privilege account see another team? | `authz-gate.test.ts` → *data scoping (BOLA)* |
| Is the TOTP implementation real? | `totp.test.ts` — RFC 6238 published vectors |
| Can one signed token be replayed as another? | `auth-principal.test.ts`, `stepup.test.ts` |
| Does a bad exposure value fail open? | `exposure.test.ts` |
| Is the lockout a DoS against a colleague? | `rate-limit.test.ts` |
| Is a fleet route nobody has written yet already guarded? | `capability-guard.test.ts` — the `/api/fleet` prefix |
| Can a start request open a session somewhere nobody named? | `fleet-spawn.test.ts` |

```bash
bun test                    # the whole suite
agentop doctor --exposed    # the deployment's own state
```

And end to end, against a running instance: the checklist at the end of
[exposure.md](exposure.md).

## Billing detection — a narrow window onto the most sensitive files

`GET /api/billing/detect` proposes how this machine is billed by reading
`~/.claude.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json` and
`~/.claude/.credentials.json`. Those files also hold live OAuth access and refresh tokens, the
user's mail address, and account and organization identifiers.

**The whitelist is the boundary, and it is enforced by the type and by a test.**
`BillingSignals` (`@agentistics/core/billingDetect.ts`) is a narrow, flat interface listing exactly
the fields that may be extracted: three routing environment variables, the presence of an API key,
`apiKeyHelper`, three `oauthAccount` fields, two credential fields and a pair of usage totals.
Nothing else can be expressed, so nothing else can be carried.

The reader (`packages/server/server/billing-detect.ts`) copies values with a `pick()` that takes a
fixed key list rather than spreading a parsed object — a spread would carry whatever the file
happens to contain, which is the failure mode being designed against. `ANTHROPIC_API_KEY` is
reduced to the literal `'set'`: its presence is the signal, its value is a credential there is no
reason to hold, not even in memory.

`billing-detect.test.ts` enforces this two ways:

1. **A source-text guard.** It reads both modules' own source and fails if either so much as
   *names* a forbidden field. A field the code cannot name is a field it cannot leak. This is
   deliberately cruder than a behavioural test — it fails on a comment, a type or a fixture.
2. **A shape walk** over the real result, asserting the key set is a subset of `BillingSignals`
   and that no value is long, contains `@`, or carries a credential-shaped prefix.

**Codex's plan lives inside a bearer token, and only its payload is read.** `~/.codex/auth.json`
holds an OAuth pair and an optional API key beside the one fact wanted — the ChatGPT tier, which
OpenAI writes nowhere else but as a claim inside the ID token. `readJwtClaim` splits the token,
base64url-decodes the **payload segment only**, and returns the one named claim; the token string
never leaves that function and is not stored, logged or put in `CodexSignals`, which carries two
fields total (`planType`, and `apiKey: 'set'` as a presence). The source-text guard is extended
with `access_token` and `refresh_token` accordingly, so the module cannot name the pair sitting
beside what it reads.

The signature is deliberately **not** verified: verifying would need OpenAI's keys over the
network, and the question here is not whether the token is genuine but what the user's own machine
already believes about their plan. A forged token in someone's own home directory mis-prices only
their own dashboard, and the result is a proposal they confirm.

**macOS is not probed.** The credentials there live in the login Keychain, and this product does
NOT shell out to `security` to reach them — that raises a system prompt, and a metrics dashboard
has no business asking someone to unlock their keychain. An absent signal is absent, and the
detection chain falls through to the next one.

**Exposure.** The route is registered in `capability-guard.ts` under `localTranscripts` rather
than a capability of its own: its answer is host configuration read out of private files, and
there is no deployment that should read a transcript but not this. It additionally returns 404 on
a central, which aggregates many machines and would only ever see its operator's own setup.
`capability-guard.test.ts` pins both the mapping and a near-miss path, so a typo in the
registration fails loudly rather than quietly leaving a host-reading route unguarded.

**Nothing detected is authoritative and nothing is written.** Every result carries
`proposalOnly: true`; the user confirms it, and confirming creates an ordinary hand-entered period
through the same validation as any other. Detection can only see the CURRENT state, while the
billing timeline most needs to know when a plan STARTED — which no file records. Auto-applying
would price months the user was on something else.

**The timeline never travels.** `Preferences.billing` is local: it is not in `IngestBody`, not in
a team document, not in an audit event. What someone pays is theirs, and a central cannot price a
fleet from one operator's timeline anyway.
