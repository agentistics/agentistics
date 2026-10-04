/**
 * clipboard.ts — CD-19, PURE: the bytes that put text on the person's clipboard through the
 * TERMINAL (OSC 52), which is what makes `/copy` work over SSH and inside tmux, where no clipboard
 * command on this machine could reach the one on the person's desk.
 *
 * The screen writes the sequence through `altScreen.writeFrame` — never `process.stdout.write`, which
 * would land in the buffer Ink is repainting (the Terminal UI rule) — and says honestly what it
 * cannot know: whether the terminal accepted it. Several do not (GNOME Terminal and other VTE-based
 * ones ignore OSC 52 outright), and tmux forwards it only with `set -g set-clipboard on`.
 */

/**
 * Past this the sequence is refused rather than sent. Terminals cap OSC 52 (xterm's default is well
 * under this, and several drop the whole sequence silently when it is exceeded), so a copy above it
 * would report success and put nothing on the clipboard.
 */
export const OSC52_MAX_CHARS = 100_000

/** UTF-8 then base64, without `Buffer` — the payload OSC 52 carries. */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** `ESC ] 52 ; c ; <base64> BEL` — set the clipboard selection to `text`. */
export function osc52(text: string): string {
  return `\x1b]52;c;${base64Utf8(text)}\x07`
}

/** Characters as a person counts them (code points, not UTF-16 units). */
export const charCount = (text: string): number => [...text].length
