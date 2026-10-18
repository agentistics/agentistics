# Release 2026-10-18: live QA round 4 fixes

Scope: reopen banner at narrow sidebar widths, closed-folder icon/name spacing, summary separators,
and Billing harness/login subtitle lines. Existing issue: #1085. Agentask: t-9e7f358801 / s-3b2c343a07.

Author verification uses real components with synthetic fixtures in Chromium, inside `agentop run
--rm`; it does not replace independent live QA. No production data or service was changed.

- Five related suites together: 93 tests passed, 789 assertions.
- Incremental TypeScript check: exit 0, using the pre-commit cache and 1536 MB Node heap.
- 24 sidebar cases: 220, 250, 288 and 390px; Portuguese/English; 1, 10 and 128 fallen sessions.
  Icon and visible label stay within the reopen button; dismiss stays separate; closed folder glyph
  is fully contained; “Agentistics Side Tasks” uses one line; summary has no dots; page has no overflow.
- Four Billing cases: 1440 and 390px, dark/light. Harness and login occupy separate lines with no dot;
  page has no horizontal overflow.
- Screenshots: `aside-{220,250,288,390}.png` and `billing-{1440,390}-{dark,light}.png` here.

The preview used port 47793. Test HOME and browser profile were disposable. Independent live QA and
owner validation remain with the release leader. Nay/Redefinir overlap and release notes are outside
this fix's scope.
