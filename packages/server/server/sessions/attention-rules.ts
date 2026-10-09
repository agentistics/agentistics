/**
 * attention-rules.ts — PURE. The per-harness screen markers, READ FROM REAL FRAMES.
 *
 * Every pattern here was captured on 2026-08-13 by starting the CLI under tmux and reading
 * `capture-pane -p`. Nothing is written from memory of what a CLI prints, for the same reason
 * `spawn-spec.ts` reads every flag from the tool's own `--help`: a plausible-looking pattern that
 * never matches fails SILENTLY. It does not throw and it does not look wrong — it just reports a
 * working session as waiting, forever, and the counter that was supposed to earn this feature its
 * place becomes noise.
 *
 * Two findings from that probe are load-bearing, and both contradict what the patterns would have
 * been if guessed:
 *
 *  - **Claude's input box is not a discriminator.** The `❯` prompt line and its two rules are drawn
 *    identically while a turn is running and after it finishes. Only the FOOTER changes —
 *    `esc to interrupt` while working, `? for shortcuts` when done. A rule keyed on the box would
 *    have called every working session waiting.
 *  - **Codex has no working marker at all.** Its status footer and its ghost placeholder
 *    (`› Find and fix a bug in @filename`) are byte-identical while it streams output and while it
 *    sits idle. For codex, movement is the only working signal that exists, so `working` is absent
 *    rather than approximated.
 *
 * `Record<HarnessId, … | null>` and not a `Partial`: a harness added to `HarnessId` must fail the
 * build until someone decides, exactly as `SPAWN_SPECS` and `HARNESS_CAPABILITIES` do. `null` is
 * that decision — "not probed", which the UI reports as approval detection being unavailable.
 *
 * No pattern may carry the `g` flag: `RegExp.test` is stateful with it and alternate calls return
 * false. The test asserts this.
 */

import type { HarnessId } from '@agentistics/core'
import type { AttentionRules } from './types'

export const ATTENTION_RULES: Record<HarnessId, AttentionRules | null> = {
  claude: {
    probed: 'claude 2.1.231 + 2.1.232, 2026-08-13 and 2026-08-14',
    approval: [
      // The startup/select component: the folder-trust dialog it opens with, and `/model`.
      /Enter to confirm · Esc to cancel/,
      // **The PERMISSION prompt, and it is a DIFFERENT component with a different footer.** The
      // line above does not match it, which was measured the hard way on 2026-08-14: a live claude
      // 2.1.232 sitting on "Do you want to proceed?" reported `waiting`, and the prompt that was
      // then typed into it went into the dialog's own filter — where the submit selected the
      // highlighted option and approved a shell command nobody had read. That is the exact accident
      // this whole feature exists to prevent, and it was one rule away.
      //
      // Captured from TWO distinct permission dialogs, which is what makes this the component's
      // footer rather than one dialog's wording — the same standard the gemini entry below holds
      // itself to:
      //   Bash   `Esc to cancel · Tab to amend · ctrl+e to explain`
      //   Write  `Esc to cancel · Tab to amend`
      // The shared part is what is matched. `ctrl+e to explain` is offered only where there is a
      // command to explain, so keying on it would have missed every file edit.
      /Esc to cancel · Tab to amend/,
      // **A THIRD component, with a third footer**, captured from a live `AskUserQuestion` on
      // 2026-08-14 (claude 2.1.232):
      //   `Enter to select · ↑/↓ to navigate · Esc to cancel`
      // Neither line above matches it, so a session waiting on a question with four answers read as
      // plain `waiting` — which is how a user came to be looking at "how do I promote this to prod?"
      // with no way to answer it from here.
      //
      // Three claude dialogs, three footers. The lesson from the second one — probe every dialog a
      // harness draws, not the first one it shows you — is now a measured pattern rather than an
      // inference: assume there is another until somebody has looked.
      /Enter to select · ↑\/↓ to navigate/,
      // **THE FOOTERS CHANGED, AND THE DETECTION WENT BLIND WITH THEM.** Measured 2026-09-04
      // against the INSTALLED claude 2.1.261: `Tab to amend` appears 0 times in the binary and
      // `↑/↓ to navigate` never appears in the order the line above expects. So on a current
      // claude none of the three rules above match anything, and a session sitting on a question
      // read as plain `waiting`: no approval card in the web chat, no refusal when a prompt was
      // sent into it. Reported with the terminal open beside the browser — an `AskUserQuestion`
      // with four answers on screen and a chat that said nothing about it.
      //
      // Captured LIVE from that report's own screenshot (claude 2.1.261, 2026-09-04):
      //   `Enter to select · Tab/Arrow keys to navigate · Esc to cancel`
      // and confirmed present in the 2.1.261 binary. Matched on the navigation half, which is the
      // part that names the COMPONENT — `Esc to cancel` alone is shared with dialogs that are not
      // questions, and `Enter to select` alone appears in pickers that are not blocking.
      /Tab\/Arrow keys to navigate/,
      //
      // **STILL UNVERIFIED on 2.1.261: the PERMISSION prompt.** Its old footer is gone and a live
      // one could not be captured on this machine — Bash is auto-approved here, so the dialog
      // never opens (measured: two commands that should have asked, neither did). It is left
      // UNGUESSED rather than approximated from strings in the binary: a wrong approval pattern is
      // worse than a missing one, because it makes a session that is NOT blocked refuse prompts.
      // The next person with a machine that asks should capture it and add it here.
    ],
    // The footer while a turn runs. `? for shortcuts` takes its place when the turn ends.
    working: [/esc to interrupt/],
    // The MAIN agent producing — see `AttentionRules.mainWorking`. Captured from a live session on
    // 2026-09-05 (claude 2.1.261): `· Jitterbugging… (37s · ↓ 1.7k tokens · thought for 17s)`. The
    // verb is whimsical and changes every frame; the elapsed time and the token counter do not.
    mainWorking: [/\(\d+[hms][^)]*·\s*↓/],
  },
  codex: {
    probed: 'codex 0.113.0, 2026-08-13 + codex 0.160.1, 2026-10-07',
    approval: [
      // 0.113.0's update picker.
      /Press enter to continue/,
      // 0.160.1's command, network and patch approvals (fixtures/codex-0.160.1/). For a release
      // these read as `waiting`: the terminal showed the question and the chat offered no card.
      /Press enter to confirm or esc to cancel/,
      // 0.160.1's directory-trust prompt.
      /enter continue · esc back/,
      // codex-cli 0.160.x startup daemon-settings question. Unlike the other prompts this is
      // drawn before the first conversation turn, so it must be recognised from its option footer.
      /Run without daemon this time[\s\S]*Restart with these settings[\s\S]*Cancel/,
    ],
    // `working` deliberately absent — see the header.
  },
  kimi: {
    probed: 'kimi 2.1.1, 2026-10-09 (the first, 0.35.0 2026-08-13)',
    approval: [
      /↑↓ navigate · Enter select · Esc exit/, // 0.35.0's folder-trust dialog, footer under the title
      // 2.1.1 has THREE blocking dialogs and each draws its footer differently — captured live from a tmux pane:
      //  - folder trust: the `↑↓ navigate …` line moved to the TOP, under the title, with the folder, a paragraph
      //    and four option lines below it, so it sits ~14 rows above the bottom. The last line the dialog owns is
      //    the description of its last option, which is stable text of its own;
      /Exit Kimi Code\. Asked again next launch\./,
      //  - a tool approval (`▶ Run this command?`, `▶ 1. Approve once` … `4. Reject with feedback`);
      /↑\/↓ select · [\d/]+ choose · ↵ confirm/,
      //  - AskUserQuestion (`→ [1] red` … `[4] Other`).
      /↑↓ select\s+[\d-]+ \/ ↵ choose/,
    ],
  },
  gemini: {
    probed: 'gemini 0.55.1, 2026-08-13',
    // Captured from TWO different blocking dialogs — the folder-trust prompt it opens with and an
    // authentication confirmation — which is what makes this the component's footer rather than one
    // dialog's wording.
    approval: [/Enter to select · ↑\/↓ to navigate/],
    // No working marker found: gemini's frame while a turn runs was not distinguishable from its
    // idle one in the frames captured, so movement is the only signal. Absent, not approximated.
  },
  copilot: {
    probed: 'GitHub Copilot CLI 1.0.79, 2026-08-13',
    approval: [/↑\/↓ to navigate · enter to select/],
  },
  antigravity: {
    probed: 'agy 1.1.25, 2026-09-09',
    approval: [
      /↑\/↓ Navigate · enter Confirm/i,
      /Enter to confirm/i,
      /tab Amend/i,
      /ctrl\+g edit/i,
      /ctrl\+r Review/i,
      /Do you want to proceed/i,
    ],
  },
  // Never spawned by agentop (no spawn-spec, CLAUDE.md step 4 skipped by scope), so nobody has
  // captured a dialog footer for it — `rulesFor` reads this as "never probed" via the `?? undefined`
  // below, exactly like a harness nobody has looked at.
  opencode: null,
}

/** The rules for a harness, or `undefined` when it was never probed. */
export function rulesFor(harness: HarnessId): AttentionRules | undefined {
  return ATTENTION_RULES[harness] ?? undefined
}
