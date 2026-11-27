# @agentistics/contract

The versioned wire contract between agentistics on your machine and **Agentistics Cloud** (decisions
E9/E15): pairing (RFC 8628 device grant), key-bound tokens (RFC 9449 DPoP with the machine's Ed25519
key), the machine's own record, metrics ingest (computed metrics only — never content) and, since
1.1, the encrypted backup (everything sealed on the device). Licensed Apache-2.0 (`LICENSE`).

| | |
|---|---|
| `openapi/machine-v1.yaml` | the contract, OpenAPI 3.1 — **the source of truth** |
| `fixtures/v1/` | golden exchanges: a request and the answer the Cloud must give |
| `CONTRACT.lock` | sha256 of spec + fixtures per version, checked here and by the Cloud |
| `src/index.ts` | typed mirror (constants, request/response types) for agentop's cloud client |
| `src/json-schema.ts` | the dependency-free checker for the schema subset the spec uses |

**Version 1.1.0.** Semver per surface: a new optional field or operation is MINOR; removing,
renaming or tightening anything is MAJOR; a MINOR is safe because clients ignore unknown response
fields and the Cloud drops (and counts) unknown request fields. Never send content: a field named
like content (`CONTENT_FIELDS`) makes the Cloud refuse the whole push.

**Do not edit `openapi/`, `fixtures/` or `CONTRACT.lock` here.** They are byte-identical copies of the
Cloud's contract and arrive as a patch from the Cloud side; `bun test` fails if they drift from the
locked digest.
