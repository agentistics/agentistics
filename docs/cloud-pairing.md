# Pairing a machine with Agentistics Cloud

`agentop cloud login | status | logout`. Pairing only: nothing is uploaded yet, and there is no web
screen yet. The contract already describes the encrypted backup (1.1); the app does not call it yet.

## Configuration

There is **no default URL** (the service is not deployed yet). Set `AGENTISTICS_CLOUD_URL`, or in
`~/.agentistics/preferences.json`:

```json
{ "cloud": { "url": "https://your-cloud.example" } }
```

The URL must be `https://` (`http://` only for this computer), without credentials, query or
fragment. With none set, every `agentop cloud` command says so and exits 1.

## Commands

| Command | What it does |
|---|---|
| `agentop cloud login [--name <name>]` | Prints a link and a code to approve in the browser, then waits |
| `agentop cloud status` | The machine as the Cloud holds it, its allowed flows and key fingerprints; exit 1 when not connected |
| `agentop cloud logout` | Revokes the machine at the Cloud and removes the local credential. Local data stays |
| `agentop cloud logout --local` | Removes the local credential without telling the Cloud |

The agentop service must be running (`agentop server`).

## How it works

- The wire contract is `packages/contract` (`@agentistics/contract`): the OAuth device grant
  (RFC 8628), DPoP proofs signed with the machine's Ed25519 key (RFC 9449) and a refresh token bound
  to that key.
- The keys and the credential are sealed by the vault (`cloud-identity.sealed`,
  `cloud-credential.sealed`; docs/security.md §7a). They are not part of a plain backup; a restored
  machine pairs again.
- Only the service holds the vault open, so it does the pairing and every Cloud request
  (`server/cloud/`). The CLI asks it over `vault.sock` (`cloud-*` ops) and receives only what it
  prints: never the device code, a token or a private key. The socket's `seal` op refuses the two
  `cloud-*` purposes, so only the service writes these records.
- The credential records the URL that issued it. The refresh token is only ever sent there, whatever
  the setting says later, and redirects are refused.
- The access token (15 minutes) lives in memory only and is refreshed 60 seconds before it expires.

## Limits

- **Known limit (accepted for pairing only):** `vault.sock` is open to any process of the same OS user, so such a process can ask the service to
  start a pairing or to log out. A pairing still needs a person to approve it in a browser, but it
  can be approved into someone else's workspace. Nothing is sent to the Cloud yet. **The upload of
  history and backup (PV.4c) will require its own confirmation by the person**; being paired is not
  consent to upload.
- A vault bundle (the encrypted vault backup, opened only by the 24 recovery words) carries every
  sealed record, these two included.
