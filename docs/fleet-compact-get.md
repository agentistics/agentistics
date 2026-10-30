# Compact fleet polling

`GET /api/fleet` remains the full legacy response, including both `sessions` and `rows`. Clients may request `GET /api/fleet?format=compact-v1`, which returns the same compact row representation as the events snapshot: merged `sessions`, a per-response `verbCatalog`, `closed: { total, sent }`, and `closedVersion`. It includes all live rows and defaults to zero ended rows; `closed=N` requests a bounded window. History (`closed`, `exited`, and `lost`) is available from `/api/fleet/closed?offset=0&limit=100` and has its own catalog per page. The events protocol is unchanged.

An older server can ignore the format parameter and return both legacy arrays. Consumers must detect and accept that response, and expand each compact catalog before using its verbs. A compact row contains both the list and control facts; do not infer action availability from state alone. Polling consumers that need complete history must load its pages and handle a failed or changing history rather than presenting an incomplete result as complete.

`format=links-v1` is an opt-in full identity graph for MCP's parent lookup, limited to identity, title, conversation and parent identifiers; older servers ignore it and return their legacy `rows`. Both formats use the same capability checks as the legacy fleet endpoint.
