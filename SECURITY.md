# Security policy

## Reporting a vulnerability

Please report privately, not as a public issue: open a
[GitHub security advisory](https://github.com/agentistics/agentistics/security/advisories/new)
on this repository. That channel is private until a fix ships.

Useful in a report: the version or commit, the deployment shape (solo machine / LAN central /
public central behind a tunnel), and the smallest reproduction you have. A proof of concept is
welcome but not required — a clear description of the flaw is enough.

There is no bounty. Expect an acknowledgement within a few days.

## Why this repository is public, and why that is fine

The source is public and the security controls are described in detail in
[docs/security.md](docs/security.md) and [docs/exposure.md](docs/exposure.md). That is deliberate, and it is not in tension with the
security work.

Security here rests on **secrets and configuration, never on the code being unreadable**
(Kerckhoffs's principle). Concretely:

- Every secret is operator-supplied at runtime and never lives in the repository: the session
  HMAC key, the dashboard password, machine tokens, Mongo credentials, the tunnel token.
  `*.env` is gitignored; no credential is committed.
- Account passwords are stored as argon2id hashes and machine tokens as sha256 hashes, so the
  storage format being public buys an attacker nothing.
- TOTP is RFC 6238 and the session cookie is a standard HMAC construction. Both are meant to be
  publishable; their strength is in the key, which is per-instance and random.
- Knowing which routes exist does not grant access to them. The authorization gate is
  deny-by-default and its exact public allowlist is asserted by a test
  (`packages/server/server/authz-gate.test.ts`) precisely so it can be reviewed in the open.

What a public repository *does* change is that the defaults matter more, because an attacker
reads them too. That is why the defaults are the conservative ones: the central binds
`127.0.0.1`, an unrecognised exposure value fails closed to the most restrictive profile, and
there is no configuration flag that re-enables shell access on an instance marked `public`.

The reverse — a private repository — would not have prevented any of the issues this project has
fixed. It would only have delayed someone else noticing them.

## Scope

For how the controls fit together and what each one does *not* do, read
[docs/security.md](docs/security.md).

**In scope:** the server (`packages/server`), the web app (`packages/web`), the MCP server
(`packages/mcp`), the shared core (`packages/core`), and the Docker/compose deployment.

**Out of scope:** a compromised host or Cloudflare account, a malicious instance owner (an owner
is fully trusted by design), physical access to the machine, and vulnerabilities in the AI
coding assistants whose data this project reads.

## Deployment guidance

If you run a central reachable by anyone other than yourself, read
[docs/exposure.md](docs/exposure.md) and run:

```bash
./central.sh doctor --exposed        # or: agentop central doctor --exposed
```

It exits non-zero until every control is configured. A check it could not verify is reported as
a failure, never as a pass.
