# Agentistics — product, cloud and plans (DRAFT)

> **Status: draft, not pushed.** Destination: `agentistics/agentistics-cloud/docs/` (private). It must
> never land in the public repository. Every rule here traces to a numbered decision in
> `2026-09-26-enterprise-decisions.md` (E1–E31); where the two disagree, the decision record wins and
> this document is the one to fix.

## 1. What Agentistics is

**An operating environment for coding agents** (E1). Any agent — the native Agentistics harness or an
external one (Claude Code, Codex, Gemini, Copilot, Antigravity, Kimi) — works inside it; Agentistics
orchestrates, measures, follows and verifies the deliveries.

**Thesis.** Every vendor sells its own agent. Agentistics is the one place that sees all of them
together, knows what each cost, and organises the work between them. Running agents in the cloud is
a crowded, capital-heavy market; controlling, measuring and organising agents that run anywhere is
nearly empty, and it is what the product already does.

## 2. Principles (each is binding)

1. **One machine is free; joining machines or people is paid** (E2, E27). The line is structural —
   it follows what we must host — never an arbitrary feature gate.
2. **The machine decides.** Consent, sharing rules and verb allowlists are enforced on the device;
   the hub's copy of a check only saves a round trip (existing team-mode rule, kept).
3. **The hub never reads conversation content or code** and never stores it (E6, E8). Content
   crosses only end-to-end encrypted, with device consent, under the sharing rules, on demand.
4. **Never intermediate a vendor credential** (runtime master spec §22.3). Harness logins stay on the
   machine where the session runs; our runner (form D) uses API keys only.
5. **The local product never requires an account** (E25), not even for new engine features. The
   account is offered only when the person chooses a cloud feature; the engine is protected by its
   EULA and the minified build, never by a login.
6. **N/A, never a confident zero** — applies to every hub surface exactly as it does locally.

## 3. The model

| Entity | Meaning |
|---|---|
| **Account** | A person, signed in with Google/GitHub (OAuth) or an e-mail magic link (E5). |
| **Workspace** | The tenant. Holds devices, members, tasks, metrics, policies. A person may belong to several (personal + company) and switches between them. Membership by invitation or verified domain. |
| **Device** | Any installation that connects outbound to the hub. Replaces "member". |
| **Environment** | A device's execution context. One machine may expose several: Windows native and each WSL distro are separate environments of one machine (desktop, Q10). |
| **Runner** | Where a session executes: a device, the user's own server, our runner (phase 6), or CI. |
| **Session / Run** | As defined by the runtime (D1): a Session is the unit of work; a harness conversation is a Run inside it. |

"Central" and "member" survive only as the self-hosted community edition's vocabulary (E30).

## 4. Execution forms (E3, E4)

| Form | Where it runs | Install | Laptop closed | Harness login | Who pays the machine | When |
|---|---|---|---|---|---|---|
| A · account only | nowhere | no | — | — | — | v1 |
| B · your device | your laptop/desktop | `agentop` / desktop app | no | your subscription | you | v1 |
| C · your server | any Linux you control | one pairing command | yes | your subscription (own machine) | you | v1 |
| D · our runner | a machine we rent | no | yes | **API key only** | us, billed by usage | phase 6 |
| E · CI | GitHub Actions | a workflow step | yes | API key | GitHub | exists |

Form C is cloud-agnostic: `curl … | sh -s -- --pair <code>` on any Linux. We never hold the user's
cloud credentials.

## 5. Hub architecture

### 5.1 Components (all in `agentistics-cloud`)

- **API** — one public REST API, described in OpenAPI; the only door (E11). The web app, the hosted
  MCP and the SDK all sit on it.
- **Web app** — workspace screens only: metrics, tasks, fleet, accounts, billing. Session screens are
  NOT re-implemented; they come through the tunnel (5.3).
- **Relay** — terminates each device's outbound WebSocket and forwards end-to-end encrypted frames
  between a device and an approved viewer. Who-is-connected-where lives in the database, never in
  process memory, so a second instance plus a Pub/Sub bus can be added without a rewrite (E10).
- **Auth** — OAuth (Google, GitHub), magic link, device authorization grant for pairing (E5); generic
  OIDC/SSO for Enterprise later.
- **Tenancy layer** — every record carries its workspace id; one mandatory query layer applies it,
  and a test fails the build when a query escapes it (E6).
- **GitHub App broker** — holds the App's private key (Secret Manager) and mints 1-hour,
  repository-scoped installation tokens on a device's request (E7).
- **Hosted MCP** — one endpoint per workspace, OAuth-protected, over the public API (E11).
- **Billing** — Stripe; seats are people (E14). Needed only at phase 4.

### 5.2 Data

| Stored by the hub | Never stored by the hub |
|---|---|
| accounts, workspaces, memberships, roles | conversation content |
| devices, their public keys, presence | code, diffs, file contents |
| computed metrics (kept forever, E17) | harness credentials |
| tasks and their metadata (opt-in per task) | the user's cloud credentials |
| fleet state (rows reduced by the existing allowlist) | E2E session keys |

Deleting a workspace is a hard delete within 30 days, backups included; JSON export at any time; a
DPA template for companies (E17).

### 5.3 Remote access (E8, E12, E31)

The phone opens the Alienware's session: the hub relays the very calls a browser would make to that
machine's local app, end-to-end encrypted over the device's outbound socket. No Tailscale, no open
port. Parity is automatic: whatever the local app (and the engine) shows appears remotely.

- Each viewer (browser/phone) generates a non-extractable keypair. It may read a device **only after
  approval by a device the person already trusts**, comparing a 6-digit code. **The hub can never add
  a viewer by itself.**
- Lost phone = revoke; no key recovery is needed because the hub holds no content.
- Device consent is **off by default**, and the sharing rules bind reading and acting alike.
- **The device-side cryptography is public (FSL)** so the promise can be verified (E31).
- Metric ingest accepts old agents for a long time; the tunnel requires a minimum version and says
  "update agentistics" instead of failing silently (E15).

### 5.4 Infrastructure (E10)

Cloud Run with exactly one instance (min 1, max 1) + MongoDB Atlas, both in São Paulo
(`southamerica-east1`); Secret Manager; uptime monitor, error tracking and a status page from day
one (E23). The hub is one Docker image built from `agentistics-cloud`, pushed to a private registry.
Cloud Run caps a WebSocket at 60 minutes; the agent reconnects.

Indicative monthly cost in validation: ~US$80–130 (Cloud Run ~50–65, Atlas Flex 8–30 → M10 ~57 with
paying customers, the rest in free tiers). Prices read 2026-09-26; re-check before committing.

## 6. Roles (E13)

Owner, admin, member, viewer, billing. A member sees their own cost and the team total; an admin
sees cost per person. **Opening another person's session always requires that person's machine's
consent; an admin cannot override it.**

## 7. Where each piece lives (E26)

| Piece | Repository | Licence |
|---|---|---|
| Community product: core, web, TUI/cockpit, CLI, local server, sessions, ALM, self-hosted central, VS Code, MCP, metric readers, **engine interface**, **the journal and projections** (2026-09-29), **device side of the tunnel and its crypto** | `agentistics/agentistics` (public) | FSL-1.1-ALv2 |
| Native harness runtime, canonical integrations, live ingestion | `agentistics/agentistics-engine` (private) | proprietary EULA, free use |
| Hub: API, web workspace screens, relay, auth, tenancy, GitHub App broker, hosted MCP, billing | `agentistics/agentistics-cloud` (private) | proprietary |
| Integration SDKs (generated from the OpenAPI spec) | public, own package | Apache-2.0 |
| Enterprise decisions, this spec, pricing, go-to-market | `agentistics-cloud/docs` | private |
| Public contracts: engine interface, device ↔ hub protocol (ingest + tunnel) | public repository, versioned (semver, contract-tested in both repos) | FSL / documented |

Sequencing (E26): transfer the public repository after the runtime's M1; extract central code from
`packages/server` after its C1, coordinated with the runtime coordinator.

## 8. Desktop (pending Q10)

Proposal awaiting the owner: Windows first, through the Microsoft Store as MSIX (free account, free
Microsoft signing), right after the minimal hub; one native agent per environment (Windows + each
WSL distro, never reading across `\\wsl.localhost`); all environments summed on one screen and every
harness detected, not only Claude; a new session runs where its repository lives (Windows native
sessions live while the app is open — `Bun.Terminal` cannot be re-attached, stated on screen);
macOS next (US$99/year), Linux last. The app is a shell over the same local agent, never a second
implementation. Today's installer picks ONE source and runs no sessions on Windows — this is new work.

## 9. Plans and pricing (DRAFT — anchors only, E27–E29)

| Plan | For | Includes | Price (anchor, unvalidated) |
|---|---|---|---|
| **Free — local** | any developer | the whole product on one machine: every harness, metrics, cost, sessions, cockpit, ALM, **the native harness engine** (EULA) | free |
| **Free — account** | anyone who chooses a cloud feature (E25) | identity, one connected device, a 14-day Pro trial | free |
| **Pro** | a developer with more than one device | several devices and workspaces, remote access from the phone with full parity, push notifications, own-server pairing, GitHub App repositories | ~US$8–12 / month |
| **Team** | teams using AI | shared workspace, per-person and per-repository cost, roles, shared board, company-provided access with per-person budgets, CI, Slack, real-bill reconciliation (E20) | ~US$20–30 / seat / month |
| **Enterprise** | large companies | SSO/OIDC, audit, self-hosted with SSO, dedicated database/region, DPA, policies | contract |
| **Runner** (phase 6) | running with no machine on | managed machines, API-key sessions | by usage |

A seat is a person; devices are unlimited under fair use (E14). Retention is not a pricing lever
(E17). **No price is fixed before 15–20 interviews; the first 3–5 design-partner teams are free.**

**Validation plan (E29).** Use it on ourselves first (personal + company workspaces, no Tailscale);
15–20 interviews with developers and team leads who run more than one agent ("what would you pay to
solve this?"); 3–5 design partners on the hosted hub for weekly feedback; publish an anonymised
"real cost of coding with AI" report; charge the first team.

## 10. Phases (the ALM breakdown's spine)

| Phase | Delivers | Verifiable exit |
|---|---|---|
| 0 · Foundation | lawyer (terms, privacy, DPA, EULA), CNPJ + accountant, GitHub App registered in the org, E26 contracts versioned | contract tests green in both repos; App installable on a test org |
| 1 · Minimal hub | OAuth sign-in, workspaces, device pairing, multi-tenant metric ingest, the tenancy-escape test | two workspaces on one hub, neither sees the other (a test proves it) |
| 2 · Remote access | E2E tunnel with viewer approval, full session parity, web push | the owner's Alienware session driven from a phone with no Tailscale; the hub's logs hold no plaintext |
| 3 · Own server + repositories | pairing install script, GitHub App clone, PR ↔ task linking | a fresh VPS paired and running a subscription session in < 10 min |
| 4 · Pro launch | billing, onboarding, central migration (`agentop central export` → import), status page | the owner's Render central migrated; first paid Pro |
| 5 · Team | roles in depth, company-provided access with budgets, governance, real-bill reconciliation, Slack | a design-partner team running on it weekly |
| 6 · Our runner | form D, API-key only | a session run with no user machine on |
| Desktop (Q10) | Windows via Store, then macOS, then Linux | after phase 1, if approved |

## 11. Open questions

1. **Q10 — desktop** (section 8).
2. **Prices** — anchors only until interviews.
3. **EULA text** — lawyer.

## 12. Non-goals

- Lending a personal subscription to another person (vendor terms).
- Storing or proxying vendor OAuth credentials.
- A hub that re-implements the local session screens.
- A per-device price.
- Anything pushed to the public repository before the relicense commit lands.
