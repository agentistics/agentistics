# Exposing an instance beyond this machine

How to let people (or your own other devices) outside the host reach an Agentistics instance — from a
LAN, a tailnet, or the open internet — without handing anyone a shell on the machine.

By default nothing needs this page: the instance listens for you on `127.0.0.1` and the profile is
`local`. It starts at the question that default leaves alone: *who can reach it, and what is it
allowed to do?*

This document is the **how**. The **why** — threat model, trust boundaries, the request pipeline,
and the limits of each control — is [`docs/security.md`](security.md).

Read it in order. §5 is a checklist you must be able to tick before the first outside request; most
of it is checked for you by `agentop doctor --exposed`.

---

## 1. The two decisions

Exposing is not one decision. It is two, and they are independent:

- **Reach** — which network can open a TCP connection to the app. Decided by `BIND_IP` and by
  whatever you put in front.
- **Profile** — what the app is *allowed to do* for whoever reaches it. Decided by
  `AGENTISTICS_EXPOSURE`.

Getting the first right and the second wrong is the failure this page exists to prevent: an
instance on a public hostname still running with local-shell routes enabled.

| You want | Reach | Profile |
|---|---|---|
| Just this host | `BIND_IP=127.0.0.1` | `local` |
| A LAN or a tailnet you trust | `BIND_IP=0.0.0.0` or your tailnet IP | `lan` |
| The internet | `BIND_IP=127.0.0.1` **+ something in front** | `public` |

**To publish on the internet you do not widen `BIND_IP`.** You keep it on loopback and put a tunnel
or a TLS terminator in front. Widening it as well adds a way in that bypasses every control at the
edge.

---

## 2. The topology

Whatever you put in front, the shape is the same and only two properties matter:

```
                     the internet
                          │
                          │  HTTPS
              ┌───────────▼────────────┐
              │   your entry point     │   TLS termination, and ideally
              │   (see §4 for options) │   WAF / rate limiting / an auth layer
              └───────────┬────────────┘
                          │  plain HTTP, host-local
    ┌─────────────────────▼──────────────────────┐
    │ host                                        │
    │    agentistics  ← 127.0.0.1:47292 (web)     │
    │                   127.0.0.1:47291 (api/mcp) │
    └─────────────────────────────────────────────┘
```

1. **The app binds `127.0.0.1`.** It is the property that makes the entry point the *only* way in,
   which is what every other control assumes.
2. **Ideally, no inbound port is opened either.** A tunnel that dials out (§4.1, §4.2) keeps the
   firewall closed entirely. A reverse proxy (§4.3) does open 443 — that is a real difference, not
   a formality, and it is why the tunnel options are listed first.

**None of this requires a specific vendor.** Cloudflare appears below because it is one concrete,
well-documented way to satisfy the shape — not because the product depends on it. Tailscale,
nginx, Caddy, Traefik, or a cloud load balancer satisfy it equally well; §4 works through each.

---

## 3. The exposure profile

One setting decides what the instance may do. It is read once at boot by
`packages/server/server/exposure.ts`, which every dangerous capability asks instead of re-deriving
the answer at the call site.

| `AGENTISTICS_EXPOSURE` | Meaning | Local shell / chat / host transcripts / MCP admin |
|---|---|---|
| unset or `local` | this machine, on 127.0.0.1 | available |
| `lan` | trusted network | off unless `AGENTISTICS_ALLOW_LOCAL_SHELL=1` |
| `public` | published on the internet | **permanently off** |

`public` ignores `AGENTISTICS_ALLOW_LOCAL_SHELL` — there is no opt-in for arbitrary shell on an
instance strangers can reach. **An unrecognised value resolves to `public`**, so a typo fails
closed.

What `public` revokes, and why each mattered:

- `POST /api/exec` — runs `bash -c` with the caller's string.
- `POST /api/chat-tty` — spawns the local coding-assistant CLI and rewrites `~/.claude.json`.
- `GET /api/{claude,codex,gemini,copilot,nay}-sessions` — returns the **host's own raw
  transcripts**.
- `POST /api/mcp-action`, `GET /api/mcp-list` — edit the host's MCP registration.
- the whole `/api/fleet` prefix — starting, driving and killing assistants.

They answer `403 {"error":"capability_disabled"}` **before** anything else runs, so an exposed
instance does not even reveal what exists behind the door.

The variables, all of them:

```sh
AGENTISTICS_EXPOSURE=public         # local | lan | public; unknown → public
AGENTISTICS_TLS=1                   # TLS terminates in front: HSTS and Secure cookies
AGENTISTICS_TRUST_PROXY=1           # believe CF-Connecting-IP / X-Forwarded-For — see the caveat
AGENTISTICS_ALLOWED_ORIGINS=        # extra origins the Host allowlist accepts (exact host:port)
BIND_IP=127.0.0.1                   # NOT 0.0.0.0 — the entry point is the only way in
```

Deliberately **not** set: `AGENTISTICS_ALLOW_LOCAL_SHELL` — ignored on `public` anyway; setting it
signals the wrong intent and is live if the profile is ever downgraded.

Two notes that have each been a real incident:

- **`AGENTISTICS_TRUST_PROXY=1` is only correct when the entry point is the *only* way in.** If the
  app is also reachable directly, a client picks its own rate-limit bucket by sending the header.
  Loopback binding is what makes this safe.
- **A name you reach the machine by must be on the Host allowlist.** The server answers `421` for a
  host-power request whose `Host` is not the machine's own name, address or an origin listed in
  `AGENTISTICS_ALLOWED_ORIGINS` (DNS-rebinding defence — see `security.md` §4a).

---

## 4. The entry point

Pick **one**. Each satisfies §2; they differ in whether a port is opened, what TLS costs you, and
what you get at the edge.

### 4.1 Cloudflare Tunnel

No inbound port: `cloudflared` dials out, so the firewall stays closed. Gives you WAF, DDoS
protection, edge rate limiting, and optionally Cloudflare Access as an independent auth layer.

```bash
cloudflared tunnel login
cloudflared tunnel create agentistics
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /home/<you>/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: metrics.example.com
    service: http://127.0.0.1:47292
  - service: http_status:404
```

```bash
cloudflared tunnel route dns agentistics metrics.example.com
sudo cloudflared service install     # run it as a service, not in a shell
```

Rotate the tunnel token periodically. If it leaks, delete the tunnel and create a new one — that
invalidates the old credentials immediately.

### 4.2 Tailscale

For a person who is already on a tailnet, this is the least machinery of any option: no public
hostname, no certificates to manage, no port opened.

```bash
sudo tailscale set --operator=$USER    # once
tailscale serve --bg 47292             # HTTPS on https://<host>.<tailnet>.ts.net
tailscale serve status
```

Open the **MagicDNS URL with no port**. Undo with `tailscale serve reset`.

With `tailscale serve` the reach is your tailnet, so `AGENTISTICS_EXPOSURE=lan` is defensible — the
network is authenticated and encrypted. Set `AGENTISTICS_TLS=1` either way, because TLS really does
terminate in front. `tailscale funnel` puts it on the **public** internet instead; that is the
`public` profile plus everything in §5.

### 4.3 A reverse proxy you run — nginx, Caddy, Traefik

This does open 443 on the host. In exchange you own the certificate and the configuration outright,
with no third party in the request path.

Caddy, which handles Let's Encrypt by itself:

```
metrics.example.com {
    reverse_proxy 127.0.0.1:47292
}
```

nginx, with certbot-managed certificates:

```nginx
server {
    listen 443 ssl http2;
    server_name metrics.example.com;

    ssl_certificate     /etc/letsencrypt/live/metrics.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/metrics.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:47292;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The live streams are WebSockets. Without these two headers the terminal and the
        # fleet stream fail while the dashboard looks perfectly healthy.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Then set `AGENTISTICS_TLS=1` and `AGENTISTICS_TRUST_PROXY=1`, and make sure the host firewall
allows **only** 443 — the app's own port must not be reachable from outside, or the header trust
above becomes a way to choose your own rate-limit bucket.

### 4.4 A cloud load balancer

ALB/GCLB/Azure AppGW in front of the host works the same way: terminate TLS at the balancer, target
the host on `47292`, and restrict the instance's security group so the balancer is the only source
that can reach that port. Set `AGENTISTICS_TLS=1` and `AGENTISTICS_TRUST_PROXY=1`. Enable WebSocket
support on the target group, or the live streams silently fail.

### Whatever you choose

- Rate-limit `/api` at the edge — the in-app limiter is the backstop, not the front line.
- Enable whatever managed WAF / bot protection the entry point offers.
- Put an authentication layer in front (Cloudflare Access, Tailscale, a proxy with auth): the
  instance itself has no login, and on a `public` profile the vault is the only thing that asks
  for a credential.

---

## 5. Before the first outside request

Run the preflight on the host:

```bash
agentop doctor --exposed
```

It must print no `✗`. A check that could not be verified reports a **failure**, never a reassuring
pass.

Then verify from **outside**, against the real hostname:

```bash
H=https://metrics.example.com

curl -s -o /dev/null -w '%{http_code}\n' -X POST $H/api/exec \
  -H 'Content-Type: application/json' -d '{"command":"id"}'      # 403
curl -s -o /dev/null -w '%{http_code}\n' $H/api/claude-sessions   # 403
curl -s -o /dev/null -w '%{http_code}\n' $H/api/fleet             # 403

curl -sI $H/ | grep -iE 'content-security-policy|strict-transport|x-frame|referrer|permissions'
curl -sI -H 'Origin: https://evil.tld' $H/api/health | grep -i access-control-allow-origin  # empty
```

And on the host:

```bash
ss -ltnp | grep -E '47291|47292'                  # 127.0.0.1, never 0.0.0.0
```

In the browser, on the real hostname, the dashboard loads with **zero** CSP violations in the
console. A violation means an inline script slipped in — fix the source, never widen the policy.

---

## 6. Incident response

| Situation | Action |
|---|---|
| The tunnel or proxy credential leaked | Delete and recreate it. For a tunnel that invalidates the old credentials immediately; for a proxy, reissue the certificate and rotate any service token |
| Something looks wrong | Read `~/.agentistics/audit.jsonl` — capability denials, misdirected hosts, rate blocks and the other recorded events |
| You are not sure the profile took effect | `agentop doctor --exposed`, and `curl` the routes in §5 from outside |
| A secret may have leaked | Rotate it at its provider; the copy sealed in `~/.agentistics` is protected by the vault, but a rotated credential is the only real fix |
