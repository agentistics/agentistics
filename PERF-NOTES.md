# Payload measurements

Measured with `packages/server/server/payload-size.test.ts` using a deterministic fixture:
1,200 sessions with long prompts, 12 projects, 365 daily stat entries, per-session histories,
agent metrics, tool totals, response-time arrays, and 1,200 workflow records. Fleet contains
12 live rows and 400 closed rows with long titles.

| Payload | Before | After | Change |
| --- | ---: | ---: | ---: |
| `/api/data` fixture JSON | 9,677,081 B (9.23 MiB) | 88,260 B (86.2 KiB) | -99.1% |
| `/api/fleet` first snapshot fixture | 301,489 B (294.4 KiB) | 23,725 B (23.2 KiB) | -92.1% |
| Real `/api/fleet/events` snapshot (808 live rows) | 1,892,248 B (1.80 MiB) | 1,360,619 B (1.30 MiB) | -28.1% |

The data reduction comes from omitting these first-screen-invisible per-session fields in the
slim response (the full response remains available on the follow-up):

| Field | Fixture bytes |
| --- | ---: |
| `user_message_timestamps` | 5,554,800 B |
| `message_hours` | 2,497,200 B |
| `agentMetrics` | 645,600 B |
| `user_response_times` | 222,000 B |
| `tool_error_categories` | 64,800 B |
| `tool_output_tokens` | 57,600 B |

The fleet first snapshot keeps all 12 live rows and only the 20-row closed window; the remaining
380 closed rows are paged through `/api/fleet/closed`. The measured 23,725 B first frame is below the
50 KiB CI ceiling. `/api/data` is additionally memoized and revalidated with an ETag/304 path, so
unchanged full or slim data is not resent.

The supplied real snapshot had 808 rows, `closed: { total: 300, sent: 0 }`, and duplicated the same
rows as both `sessions` (858,791 B) and `rows` (1,024,086 B). The new stream serializes one merged
`sessions` list, omits `rows`, removes the derived `searchFields`, and keeps `closed=0` at zero
closed rows. The browser reconstructs its `rows` alias and search index locally; the TUI, VS Code,
and core reducer consume the same single-list wire shape.

The slim query is now honored even when `slim=1` is sent without `partial=1`; this prevents an
explicit slim probe from silently taking the full response. The web's first request remains
`?partial=1&slim=1`, and the follow-up remains full.

The owner’s real-server observations in the brief were 1.7 MB for `/api/fleet` and 5.2 MB for
`/api/data`; the fixture is intentionally heavier in session count and is used as the repeatable
regression budget in tests.
