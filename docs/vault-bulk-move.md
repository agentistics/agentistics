# Moving several vault entries

In Secrets, choose **Select**, tick personal entries, then **Move to group**. **Select all** covers the current filter across pages. System secrets and trashed entries cannot be selected. Changing a filter limits the entries acted on to the current filtered set.

The destination picker offers existing groups, no group, and creation of a group from its search text. The same picker serves individual moves. After moving, the page keeps a result with the number moved and each failed entry's name and reason. Failed entries stay selected for a retry; successful entries are updated immediately in the list.

Bulk moves call the existing single-entry `/api/vault/personal/move` route sequentially, through the same page gate for each request. Each entry uses its expected version. A conflict, lock, cancelled proof or network failure is reported for that entry; it does not roll back earlier moves or replay them. A network failure may have reached the server: reload before retrying if its outcome is uncertain.

There is no new HTTP route or public MCP/CLI contract. The current MCP/CLI vault surfaces do not expose individual entry moves.

Synthetic browser evidence: `packages/web/e2e/vault-bulk.html`; run `packages/web/e2e/vault-bulk-qa.ts` with `agentop heavy -- agentop run --rm -- bun ...`. It renders the actual Secrets area using an in-memory fake vault and never reads real secrets.
