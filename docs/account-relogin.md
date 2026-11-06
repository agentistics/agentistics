# Signing in to an existing account again

Usage → Accounts and the session login banner open the same `ReloginModal`. It starts
`POST /api/accounts/roots/relogin/<accountId>`, displays the CLI's public login link,
and follows the attempt through `GET` on that route. The server signs in within the
account's existing folder and confirms the resulting identity before reporting `done`.
A failed attempt stays in the dialog with a readable error and a retry action.

Status reads start once when login metadata becomes available, then run every two
seconds. Updating the link, expiry or invalid-code metadata must not restart that
cadence. Only one status read may be in flight at a time; completion, failure or closing
the dialog stops polling. Closing an unfinished attempt also cancels it on the server.

A regression in 2.197.4 made the polling effect depend on the metadata object it
replaced after each read. Each response immediately triggered another request, flooding
the server and causing HTTP 429 responses across the app. The DOM regression test in
`ReloginModal.dom.test.tsx` checks the request cadence, slow responses, completion,
failure and retry. Browser validation uses a disconnected extra Claude account in an
`agentop run --rm --serve` HOME, never the operator's real account folders.
