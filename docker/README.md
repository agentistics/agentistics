# `docker/` — run the app in a container

The repository ships one compose deployment: `machine.yml`. It runs the same single-machine app
as the native `agentop server` command, with the host's harness directories mounted read-only and
`~/.agentistics` mounted for local preferences and data.

## Run it

Build and start from the repository root:

```bash
docker compose -f docker/machine.yml up -d --build
```

The container uses host networking and serves the API on port `47291` and the web dashboard on
port `47292`. Run the native app or the container, but not both at once.

The image runs as an unprivileged user. If live-session discovery is needed, uncomment the
`user:` line in `machine.yml` and set it to the host user's UID and GID; this allows the container
to read the host process links required for discovery.

## Exposure

Read [`docs/exposure.md`](../docs/exposure.md) before making the dashboard reachable beyond the
local machine. Use `local` for loopback-only access, `lan` for a trusted network, and `public` only
behind a reverse proxy that provides identity and access control.
