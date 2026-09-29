# Enterprise product decisions — 2026-09-25/26

**The record of what the owner decided about Agentistics as a product**, taken one question at a
time in the product session ("Agentistics Enterprise — spec de produto"). Same format as
`2026-09-25-owner-decisions.md`: each entry carries the reason and the rejected alternative. Numbered
`E1…` so they never collide with the runtime's `D1…D20`.

Where an entry changes a runtime decision (D7, D10, D14, D16), it says so and says why — those are
revisited on purpose, not worked around.

## E1 · What Agentistics is (2026-09-25)

**Both observability and platform: an operating environment for coding agents.** Any agent — native
or external — works inside it; Agentistics orchestrates, measures, follows and verifies the
deliveries. *Reason:* the product already orchestrates (sessions), measures (metrics, cost), follows
(fleet) and plans (ALM); the native harness makes it the place an agent works in. *Rejected:*
observability only — describes what the product was, not what it does today.

## E2 · Who pays (2026-09-25)

**"One machine is free; joining machines or people is paid."**
- **Free (open source):** everything on one machine — metrics, sessions, native harness, cockpit,
  tasks.
- **Pro (individual, cheap):** what exists only because we host it — several machines in one place,
  personal/company workspaces, phone access without Tailscale, notifications, history.
- **Team:** what only makes sense in a group; where the money is.

*Reason:* the line is structural (hosting), not an arbitrary feature gate, so the free product is
never crippled. *Rejected:* gating single-machine features — it makes the open core feel "xoxo" and
undermines adoption.

## E3 · What the first paid version runs (2026-09-26)

**v1 paid = (A) a cloud account + (B) the user's own devices + (C) the user's own server, all
reachable from anywhere.** Execution forms, for reference:

| Form | Where a session runs | Install? | Runs with the laptop closed | Harness login | Who pays the machine |
|---|---|---|---|---|---|
| A · account only | nowhere | no | — | — | — |
| B · your device | your laptop/desktop | `agentop` | no | your subscription | you |
| C · your server | any Linux you control | one command | yes | your subscription (own machine; confirm in each vendor's terms) | you |
| D · our runner | a machine we rent | no | yes | **API key only** (master §22.3) | us, billed by usage |
| E · CI | GitHub Actions | a workflow step | yes | API key | GitHub |

**C is cloud-agnostic:** the universal path is an install command with a pairing code
(`curl … | sh -s -- --pair <code>`) that works on any Linux — any VPS, any cloud, a home server —
plus optional conveniences (Docker image, cloud-init) later. **We never hold the user's cloud
credentials.**

*Reason:* B and C are the empty space (your machines and your subscriptions, every vendor, one
place); D is the crowded market where we compete with the vendors themselves and pay the machines.
*Rejected:* D in v1 — cost grows per customer and it only works with API keys.

## E4 · Form D is phase two (2026-09-26)

**Our hosted runner ("nothing installed") comes after v1**, first for companies that already pay for
API usage and want per-person budgets. *Reason:* see E3. *Rejected:* D in v1.

## E5 · Multi-tenant SaaS with real OAuth (2026-09-26)

**One cloud application, many companies.** A company that subscribes gets its own workspace; users
sign in with **Google or GitHub (OAuth)**, with an e-mail magic link as the fallback and SSO/SAML/
generic OIDC for Enterprise later. Membership comes from an **invitation** or a **verified domain**
(`@company.com` joins that workspace). One person may belong to several workspaces (personal +
company) and switches between them. This replaces the central's password + authenticator.

Three logins are kept strictly apart:
1. **Signing in to Agentistics** — our OAuth (Google/GitHub).
2. **Pairing a device** — our OAuth, device authorization grant (like `gh auth login`).
3. **A harness's own login** (Claude, Codex, Gemini…) — the **vendor's** OAuth, between the device
   and the vendor. We are never its client and never store it (master §22.3).

*Reason:* it is what the owner described ("like Jira"), and the provider handles MFA. *Rejected:*
one self-hosted central per company as the product — it does not scale as a service.

## E6 · Database and tenant isolation (2026-09-26)

**MongoDB Atlas, one database, every record stamped with its workspace id**, enforced in **one
mandatory layer** (the `capability-guard.ts` pattern) with a test that fails the build when a query
escapes it. Dedicated database / dedicated region (e.g. Brazil) is an Enterprise option when a
customer requires it. *Reason:* the central already speaks Mongo (`team-store`, `tags-store`,
`mongo-dates.ts`, tokens, envelopes) and already keys several collections by `org`; switching
databases rewrites all of it for no feature. *Rejected:* Postgres for row-level security — a real
advantage, bought with a full rewrite; database-per-tenant by default — operational cost with no
customer asking.

**What the hub stores:** accounts, workspaces, computed metrics, tasks, fleet state. **Never
conversation content or code.**

## E7 · Repositories through an Agentistics GitHub App, in v1 (2026-09-26)

**An Agentistics GitHub App (owned by the `agentistics` GitHub org) ships in v1.** An admin installs
it and picks repositories; a device asks the hub for a token when it clones. Installation tokens
expire after 1 hour and can be restricted to specific repositories (GitHub docs, read 2026-09-26);
the token is issued on the user's behalf so commits and PRs are attributed to the person. The hub
keeps only the App's private key (Secret Manager), never a person's token. GitLab/Bitbucket later,
same shape. *Reason:* the owner wants repository selection in this release; creating a GitHub App is
free. *Rejected:* asking users to `gh auth login` on every server as the only path — kept as a
fallback, not the product.

## E8 · Remote access is an end-to-end encrypted tunnel to the device's own app (2026-09-26)

**The hub does not re-implement session screens.** Opening the Alienware's session from a phone
tunnels the same calls a browser would make to that machine's local app, **end-to-end encrypted**
(the existing X25519 envelope primitives), over the device's **outbound** connection — which is why
Tailscale is no longer needed. The hub's own screens are only the workspace's: metrics, tasks,
fleet, accounts.

Consequences:
- **Parity by construction** — whatever the local app shows (and whatever the native runtime shows
  later) appears remotely with no extra work.
- **v1 does not depend on the runtime work** (adapters, native harness), and the runtime cannot break
  v1. Only sequencing inside `packages/server` must be agreed with the runtime coordinator.
- **End-to-end encryption is a requirement, not a bonus:** a harness's login code (form C, logging a
  subscription in on your own server) travels through the relay; if the hub could read it, we would
  be intermediating credentials, which Anthropic's terms forbid.

**Revises D10 and D16** (and bounds D7/D14): the rule "conversation never leaves the machine"
becomes "**conversation leaves only end-to-end encrypted, only with the device's consent (off by
default), only under the sharing rules, fetched on demand, and never stored by the hub**". D7 (no
event push to a central) and D14 (no repository memory to a central) are unchanged: the tunnel moves
bytes the hub cannot read; it does not make the hub a store.

*Rejected:* hub-side session screens fed by relayed data — every screen implemented twice, parity
always behind, and the hub reading content.

## E9 · Repositories and the `agentistics` GitHub org (2026-09-26)

*Decided by the owner and relayed by the runtime lead session (688e4a0205); recorded on the board as
task `t-cf96eb10bd`; the owner pasted it into this session as confirmation.*

**Two repositories under the `agentistics` GitHub org** (created by the owner, who is admin):
- **`agentistics/agentistics` — public:** the whole current monorepo; every npm package is published
  from it, including `@agentistics/runtime`.
- **`agentistics/agentistics-cloud` — private:** the paid hub.
- **Between them, a public and versioned contract** (ingest + the reverse-channel/tunnel protocol).

**Not one repository per package.** Order: the org exists now, so the E7 GitHub App can be
registered in it today; the public repository is transferred only **after the runtime's M1**; the
central code is extracted out of `packages/server` only **after the runtime's C1**, coordinated with
the runtime coordinator (98788a5f11). **What is closed and the licence stay open questions for this
session (and the lawyer).**

*Rejected:* one repository per package — every cross-package change becomes several PRs, for no
isolation the contract does not already give.

## E10–E24 · The v1 foundations and their phases (2026-09-27)

Proposed as one numbered batch and **approved by the owner in full** ("concordo com essas coisas ai
sim"). Each keeps its reason; rejected alternatives are stated where one was on the table.

**E10 · Where the hub runs.** Cloud Run with exactly one instance (min 1, max 1), MongoDB Atlas in
the same region, **São Paulo (`southamerica-east1`)**; leave Render. The hub is one Docker image built
from `agentistics-cloud`, published to a private registry. Who-is-connected-where lives in the
database, never in process memory, so a second instance plus a Pub/Sub/Redis relay can be added
without a rewrite. *Reason:* one instance comfortably holds hundreds of device sockets and needs no
cross-instance relay; first users are Brazilian (latency, LGPD); Render already blocked the central
(429 `cf-mitigated: challenge`, 2026-09-25). Cloud Run caps a WebSocket at 60 min, so the agent
reconnects (it already does). *Rejected:* multi-instance from day one — a relay bus before there is
load to justify it.

**E11 · One public API; MCP in v1; SDK in phase 2.** A REST API documented in OpenAPI is the only
door. The web app, a **hosted MCP server per workspace (OAuth)** and, later, a **TypeScript SDK
generated from the spec** all sit on it. *Reason:* the hosted MCP is cheap once the API exists and is
the best showcase ("ask your agent what the team spent"). *Rejected:* an SDK hand-written beside the
API — a second description of the same surface that drifts.

**E12 · End-to-end key management.** Every browser/phone generates its own non-extractable keypair.
A viewer may read a device **only after approval by a device the person already trusts**, comparing a
6-digit code (the WhatsApp Web gesture). **The hub can never add a viewer on its own** — otherwise a
malicious hub injects its own key and E8 is void. Losing a phone = revoke in the app; devices stop
accepting that key. **No key recovery, and none is needed**: the hub stores no content, so a lost key
means re-pairing, never lost data. *Rejected:* silent trust-on-first-use for viewers — it is exactly
the hole a hostile hub would use (the envelope channel's "trust may be automatic but never silent"
rule, applied where the stakes are higher).

**E13 · Roles.** Owner, admin, member, viewer, billing. A member sees their own cost and the team
total; an admin sees cost per person. **Opening another person's session always requires that
person's machine's consent; an admin cannot override it** — "the machine decides" stays the rule.

**E14 · A seat is a person, not a device.** Devices are unlimited under a fair-use ceiling; our
runners (form D) are billed separately by usage. *Reason:* pricing per device punishes the behaviour
the product wants — connecting every machine. *Rejected:* per-device pricing.

**E15 · Version compatibility.** The E9 contract is semver'd and contract-tested in CI on both
repositories. Metric ingest keeps accepting old agents for a long time (cheap); the remote tunnel
requires a minimum version and says "update agentistics" instead of failing silently. Agent
auto-update is on by default and can be switched off.

**E16 · Migrating an existing central.** A member runs `agentop connect` against the hub and the
existing auto-reconciliation re-pushes its whole history. Only central-only data (accounts, tags,
shared tasks, CI sessions) needs an `agentop central export` → hub import. The owner's Render
central is the first migration.

**E17 · Data and LGPD.** Computed metrics are small: **kept forever, and retention is not a pricing
lever**. JSON export at any time. Deleting a workspace is a hard delete within 30 days, backups
included. A DPA template ready for companies.

**E18 · Push notifications arrive with remote access (phase 2)** — web push through the PWA; "your
session needs you" is half the value of remote access. A native mobile app only if data asks for it.

**E19 · Integrations.** PR ↔ task linking in phase 3 with the GitHub App (nearly free). Slack
("needs you" + weekly cost digest) in phase 5. Jira/Linear sync only when a design partner asks.

**E20 · Real cost, not only estimated (phase 5, Team).** Pull the bill from the vendors' admin/usage
APIs (Anthropic, OpenAI) and reconcile it against our estimate. Applies to API-key organisations
only — a subscription has no per-token bill.

**E21 · Governance order.** Per-person budgets first (most requested); SSO through generic OIDC in
Enterprise; SCIM and advanced audit later.

**E22 · Billing.** Stripe (available in Brazil), card, USD and BRL. PIX/boleto through a local
provider only if Brazilian SMEs ask. Required only at phase 4.

**E23 · Hub operations from day one.** Uptime monitor, error tracking, a status page — cheap, and a
paid hub without them is a promise nobody can check.

**E24 · Legal before the first charge.** Terms of use, privacy policy and DPA, together with the
licence.

**Phases** (the basis of the ALM breakdown): 0 foundation (lawyer, org + GitHub App, versioned E9
contract) · 1 minimal hub (OAuth, workspaces, device pairing, multi-tenant metrics) · 2 remote access
(E2E tunnel, full parity, push) · 3 own server + repositories (install script, GitHub App, PR↔task) ·
4 Pro launch (billing, onboarding, central migration) · 5 Team (roles in depth, shared access,
governance, real cost, Slack) · 6 our runner (form D).

## E25 · The local product never requires an account (revised by the owner, 2026-09-29)

**Local use never requires a login — not even for new engine features.** The account exists only
for cloud features (several machines, the phone, a team, billing) and is offered **only when the
person chooses one of them**; it is not the primary action of the first run. The closed engine is
protected by its EULA and the minified build, never by an account. *Reason:* the free product runs on
one machine (E2, E27); an account gate on local features is friction with no protection value, since
a local binary can be reversed with or without a login. *Rejected:* (1) the original E25 of
2026-09-27 — "Sign in with Google/GitHub" as the primary first-run action with "continue without an
account" as a quiet secondary one; (2) the 2026-09-29 proposal to put new engine features behind the
free account; (3) mandatory login for everything (the Notion model) — right for a cloud-native
product, wrong for a local one.

## Revisions of 2026-09-29 (owner, relayed by the Enterprise bridge session)

**Where this document lives now.** Private repositories may carry private documentation, so this
record, the product spec and pricing belong in `agentistics/agentistics-cloud/docs`, **never in the
public repository**. Until that repository exists they stay on a local, never-pushed branch.

**Licence (decided in `2026-09-29-licensing-strategy.md`).** The public platform is FSL-1.1-ALv2
(each release becomes Apache-2.0 after two years); Apache-2.0 is reserved for future integration
SDKs. Last MIT release: `mit-final` (v2.68.7); first FSL: v2.69.0; v3 is reserved for the native
harness launch.

**E26 · Three repositories — supersedes E9.**
- `agentistics/agentistics` — **public, FSL**: the community product (core, web, TUI/cockpit, CLI,
  local server, sessions, ALM, self-hosted central, VS Code, MCP, legacy metric readers) plus an
  **engine interface**.
- `agentistics/agentistics-engine` — **private, proprietary (EULA)**: the native harness runtime,
  the canonical integrations and live ingestion. **The journal and the projections stay public**
  (project lead, 2026-09-29, Q1 option b). The official binary embeds it.
- `agentistics/agentistics-cloud` — **private, proprietary**: the hub (multi-tenant, relay,
  billing, GitHub App, hosted MCP).

Two **public, versioned contracts**: community ↔ engine (the engine interface) and device ↔ hub
(ingest + tunnel). *Rejected:* two repositories (E9) — it left no place for a closed engine.

**E27 · The closed engine is free on one machine (answers Q2).** "Free" is no longer "open
source": free = the FSL community product + the proprietary engine under a free-use EULA (no
reverse engineering, no redistribution). The free local version keeps the Agentistics harness and
the adapters usable from the web and the TUI. What is paid stays what only exists when machines or
people are joined (E2): cross-device orchestration, policies and budgets, our runner. *Rejected:*
charging for the engine on one machine — it is the adoption driver and would break E2's
structural line. *Stated limit:* a local binary can be reversed with effort; a real secret only
exists in what runs in the cloud.

**E28 · The free cloud account = identity + one connected device + a 14-day Pro trial.** It is
offered only when the person chooses a cloud feature (E25), and gives that choice a start without
giving Pro away.

**E29 · Business.** Bootstrapped (infrastructure ~US$100/month, E10); revisit when form D needs
capital. Open a Brazilian company (CNPJ) now, with an accountant and Stripe Brazil; a US entity only
if an investor or customer requires it. Price **anchors, to be validated in 15–20 interviews before
any price is fixed**: Pro ~US$8–12/month, Team ~US$20–30/seat/month, the first 3–5 design-partner
teams free.

**E30 · The self-hosted central stays in the community (FSL).** The FSL's non-compete clause is what
protects the hub for two years. Self-hosted **with SSO and audit** is sold by contract (Enterprise).

**E31 · The device side of the E8/E12 encryption lives in the public repository.** Only the hub side
lives in `agentistics-cloud`. *Reason:* "the hub cannot read your conversation" is a promise nobody
can verify if the code that encrypts it is closed.

**E25 · Revised** — see E25 above: the local product never requires an account.
