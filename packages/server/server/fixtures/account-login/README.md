These JSON strings preserve the captured CLI output, including ANSI/OSC sequences.
OAuth state and PKCE challenges and public device codes were replaced with fictional values
of the same length and character classes. No login was completed to produce these fixtures.

- `claude`: OSC 8 hyperlink to claude.com/cai/oauth/authorize.
- `codex`: one-time code with 4+5 characters, expiry between the label and code.
- `copilot`: 4+4 code in the normal and clipboard-failure prompts.
- `gemini`: initial redraw/banner only, no link (negative/preamble fixture).
- `gemini-url-invalid`: authorization URL, rejected fake input, invalid_grant, renewed URL.
  The <<<QA: typed fake code qa-fake-123>>> marker separates input from CLI output and
  must be removed when feeding the two snapshots to the fake transport.

Kimi and Claude re-prompt tests use explicitly synthetic extensions because no live capture
of those cases was supplied. Copilot plaintext refusal wording comes from the QA briefing;
no real authorization or secure-storage failure was triggered by this change.
