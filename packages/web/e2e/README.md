# Vault expiry Nay regression

`vault-expiry-nay.ts` mounts the real Nay dock, notice, watcher and SessionChat. All API responses are
simulated in Playwright; it never reads the real vault or user sessions. Vite and Chrome are children
of the throwaway run and are stopped in `finally`.

Run from the repository root with Node 24+ and Playwright's Chromium installed:

```sh
agentop run --rm -- node packages/web/e2e/vault-expiry-nay.ts ./evidence
```

Set `QA_CHROMIUM` to an installed Chromium executable when the isolated HOME cannot see the browser
cache. The script uses the throwaway `WEB_PORT` (never 47291/47292). It saves desktop and 390px views
with the Nay button, real open chat, and floating authenticator inputs. It verifies once-per-window
queue/bell delivery, one visible card and queue count, opacity, placement, explicit keep-open/lock,
step-up refusal and retry, errors, dismissal, and mobile page overflow.

## Usage r2 regressions

```sh
flock /tmp/agentistics-heavy.lock agentop run --rm -- node packages/web/e2e/usage-r2.ts .qa-usage-r2
```

`QA_CHROMIUM` may point to an installed Chromium/headless shell. This fixture mounts the real
account list, charts and area rail with synthetic readings, blocks API calls and checks desktop
and 390px in both themes. It measures the switch button itself, clicks its text, checks keyboard
opening/focus retention, neutral markers, Portuguese dates, weekly day ticks and page overflow.
Screenshots and `measurements.json` go into the specified evidence directory. This is an author
regression check; independent release QA still runs separately.
