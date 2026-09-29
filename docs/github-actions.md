# GitHub Actions — track Claude Code Actions usage per repository

agentistics can track token/cost usage from **Claude Code running inside GitHub Actions**, not
just from developers' laptops. Each Actions run is an *ephemeral machine*: it populates
`~/.claude`, then dies. `agentop ci-push` sends that run's computed metrics to your **central**
before the runner is torn down, attributed to the repository it ran in — so a repo's dashboard
shows **local devs + cloud agents together**, grouped by git remote.

This builds on the [repository dimension](./architecture.md): every session carries a normalized
`git_remote` (`host/org/repo`, no protocol), and CI runs are additionally flagged `ci: true` and
surfaced under **Repositories → Actions**.

## How it works — keyless (GitHub OIDC), recommended

```
GitHub Actions runner (ephemeral)
  ├── Claude Code Action runs  → writes ~/.claude
  └── agentop ci-push          → GitHub mints a short-lived OIDC JWT (repository claim)
                                  → POST /api/team/ingest  (Bearer <OIDC JWT>)
                                        ↓
                    Central verifies the JWT vs GitHub's JWKS (issuer/audience/expiry),
                    checks `repository` ∈ registered repos, then stamps git_remote + ci=true
                                        ↓
                            Repositories → Actions  (per repo, cross-user)
```

- **Keyless — no secret to store or leak.** GitHub signs a short-lived token identifying the exact
  `repository`; the central verifies it cryptographically. There is no long-lived secret in the repo.
- **Attribution is authoritative on the central.** `git_remote`, `ci: true`, and
  `user = github-actions` are stamped from the *verified* claim — a runner cannot mis-report its repo.
- **No chat leaves the runner** — computed metrics only (sessions/tokens/cost aggregates +
  statsCache), never raw transcripts.
- **`ci-push` never fails your job.** A push error (central down, unverifiable token) logs and exits 0.

A **static repo token** is also supported as a fallback (non-GitHub CI, or when OIDC is unavailable) —
see the end of this page.

## 1. Register the repository on the central

Registration is an **admin action** (central Team settings → Repositories, or the API). For keyless
OIDC it just **allowlists** the repo — no secret is stored.

```bash
# From an authenticated admin session on the central (cookie from the dashboard login):
curl -sS -X POST "$CENTRAL_URL/api/team/repos" \
  -H 'Content-Type: application/json' \
  -H "Cookie: $ADMIN_SESSION_COOKIE" \
  -d '{ "url": "git@github.com:org/repo.git" }'
# → { "token": "<static token — only needed for the fallback path>", "remote": "github.com/org/repo" }
# (the display name is always derived from the remote — org/repo — there is no name field)
```

`url` accepts any remote form (https / ssh / scp); it is normalized to `github.com/org/repo`.
(List/unregister: `GET /api/team/repos`, `DELETE /api/team/repos { "remote": … }`.)

Then enable OIDC on the central by setting an **audience** (any stable value; using the central URL
is natural and unique per central):

```bash
AGENTISTICS_OIDC_AUDIENCE="https://central.example.com"   # central env; the workflow requests this same audience
```

## 2. Add the push step to your workflow (keyless)

The job needs `id-token: write` so GitHub will mint an OIDC token; add the push as the **last** step
of the job that already runs Claude Code (it does **not** run Claude — your workflow already does):

```yaml
jobs:
  claude:
    permissions:
      id-token: write        # ← lets the runner request a GitHub OIDC token
      contents: write        # (your existing Claude permissions)
    steps:
      # ... your existing Claude Code Action step ...

      - name: Push agentistics metrics
        if: always()          # report usage even if the Claude step failed
        env:
          AGENTISTICS_CENTRAL_URL: ${{ vars.AGENTISTICS_CENTRAL_URL }}
        run: |
          curl -fsSL "https://github.com/agentistics/agentistics/releases/latest/download/agentop" -o agentop
          chmod +x agentop
          ./agentop ci-push
```

`ci-push` requests the OIDC token itself (audience defaults to `AGENTISTICS_CENTRAL_URL`), so the
only repo config is the `AGENTISTICS_CENTRAL_URL` **variable** — no secret:

```bash
gh variable set AGENTISTICS_CENTRAL_URL --repo org/repo --body 'https://central.example.com'
```

The central must be reachable from the runner (see Networking below).

### Authenticating the Claude step — API key *or* your Pro/Max subscription

Two **independent** credentials are in play, and it helps to keep them separate:

| Purpose | Who handles it | Credential |
|---|---|---|
| **Running Claude** in the workflow | `anthropics/claude-code-action` | `anthropic_api_key` **or** `claude_code_oauth_token` |
| **Pushing metrics** to your central | `agentop ci-push` (this project) | keyless GitHub OIDC (or the fallback `AGENTISTICS_CI_TOKEN`) |

agentistics never touches your Anthropic credentials — it only reads the `~/.claude` the Claude
step already wrote. So **yes, you can run the workflow on your Claude subscription** instead of a
metered API key. The official action supports a **Pro/Max OAuth token**: generate it once locally
with

```bash
claude setup-token          # requires a Claude Pro or Max subscription
```

store the printed value as the repo secret `CLAUDE_CODE_OAUTH_TOKEN`, and point the action at it:

```yaml
      - name: Run Claude Code
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # (instead of: anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }})
```

Either way the metrics push step below is **unchanged** — it works the same on API-key or
subscription auth. Trade-offs to know: an OAuth token is tied to **one personal account** and its
subscription rate limits (fine for a small repo, less so for a busy shared one), and inline-comment
classification currently still needs `anthropic_api_key`. For heavy or org-wide automation a
dedicated API key (or Bedrock/Vertex) is usually steadier.

## 3. See it in the dashboard

Open **Repositories** → click the repo → **Actions** tab, or **Repositories → Actions** for the
cross-repo view. CI runs are counted separately (`user = github-actions`) but roll up into the
same per-repo totals as your local sessions.

## Networking — how a cloud runner reaches the central

GitHub-hosted runners live in the cloud, so the central must be reachable from wherever the
runner runs. **Do not expose your full dashboard to the public internet** — it holds sensitive
data (repo names, member names, the first 200 chars of each prompt, titles). Pick one:

### Option A — private runner (nothing exposed)
Use a **self-hosted runner** inside your network / tailnet and point it at the private central
(`http://localhost:48080`, a LAN IP, or a Tailscale MagicDNS URL). Set `runs-on: self-hosted`.
The central never touches the public internet. Best for sensitive data.

### Option B — a public **ingest-only** central (for cloud runners)
Run a **second** central instance in **ingest-only mode** that shares the same MongoDB as your
private dashboard instance. Set `AGENTISTICS_INGEST_ONLY=1`: it serves **only**
`POST /api/team/ingest` and returns **404 for everything else** — no dashboard, no `/api/data`,
no login, no static assets. Exposing it is low-risk: an attacker finds only a token-gated write
endpoint with nothing to read.

```
        cloud runner ── POST /api/team/ingest ──▶  ingest-only central   ┐
                                                   (AGENTISTICS_INGEST_ONLY=1)  │  same
                                                                                ├─ MongoDB
   you (private) ──────── dashboard ─────────────▶  private central       ┘
                                                   (Tailscale / LAN, not public)
```

Harden the exposed instance further:
- **IP-allowlist** GitHub's runner ranges at the proxy (`actions` field of
  `https://api.github.com/meta`).
- Terminate **TLS** (a Cloudflare Tunnel / Tailscale Funnel gives HTTPS for free; or a reverse
  proxy + `AGENTISTICS_TEAM_TLS=1`).

## Static-token fallback (non-GitHub CI, or no OIDC)

If OIDC isn't available, use the repo-bound static token from registration. Store it as a secret
and add it to the step's env — `ci-push` uses it when no OIDC token can be fetched:

```bash
gh secret set AGENTISTICS_CI_TOKEN --repo org/repo --body '<the token>'
```
```yaml
        env:
          AGENTISTICS_CENTRAL_URL: ${{ vars.AGENTISTICS_CENTRAL_URL }}
          AGENTISTICS_CI_TOKEN: ${{ secrets.AGENTISTICS_CI_TOKEN }}
```

Re-registering the repo **rotates** the token; removing the repo revokes it (both delete that
repo's CI data).

## Security notes

- **Prefer keyless OIDC** — it stores no long-lived secret, so there is nothing to leak or rotate.
  The token is short-lived, GitHub-signed, and cryptographically bound to the `repository`.
- The static fallback token is stored only as a **SHA-256 hash** on the central and used as
  `Authorization: Bearer`; treat it like any secret.
- A repo must be **registered** (allowlisted) on the central before either path is accepted — a
  valid OIDC token for an unregistered repo is rejected (403).
- On a public central, set a strong `AGENTISTICS_TEAM_SESSION_SECRET` (the dashboard itself is
  gated by accounts — there is no shared password to set), and prefer the ingest-only pattern
  above so the dashboard is never the exposed surface.
