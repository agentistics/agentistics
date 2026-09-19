/**
 * editorSaveText.ts — the ONE read of the Studio's buffer that a save writes to disk.
 *
 * WHY IT IS ITS OWN MODULE. The save used to be `editor.getValue()`, and Monaco's default for that
 * call is `preserveBOM: false`. Monaco does not keep a byte-order mark in the text: when a model is
 * created (and on every `setValue`), `PieceTreeTextBufferBuilder.acceptChunk` cuts a leading U+FEFF
 * off and holds it beside the buffer (`getBOM()`). So the server handed the editor `\uFEFFa\r\n`,
 * byte-identical to the file (`editor-text.ts`), and the save wrote `a\r\n` back — a change to
 * three bytes nobody edited, reported as "Saved".
 *
 * `preserveBOM: true` puts the mark back in front. `lineEnding: ''` is the OTHER half of Monaco's
 * option type, which requires both fields: `CodeEditorWidget.getValue` (0.56) maps only `'\n'` and
 * `'\r\n'` to a preference, and anything else — `''` included — to `EndOfLinePreference.TextDefined`,
 * the model's own EOL, i.e. exactly what the default call returned. Read off the widget's source, and
 * `editorSaveText.test.ts` runs that very method rather than trusting this sentence.
 *
 * **STATED LIMIT — MIXED LINE ENDINGS ARE NOT KEPT.** Monaco's text model holds ONE end-of-line
 * sequence. A file mixing them is normalised when the model is created — measured on 0.56:
 * `a\r\nb\nc\rd` becomes `a\r\nb\r\nc\r\nd` — and there is no public option that creates a model
 * without that normalisation, so the original terminators are gone before anything here runs. A save
 * of such a file therefore rewrites line endings nobody touched. A file with ONE consistent ending
 * (all `\n`, or all `\r\n`) round-trips byte-identically, with or without a BOM; the test pins both
 * halves, so the day Monaco keeps mixed endings the limit test fails and this paragraph is removed.
 */
import type * as Monaco from 'monaco-editor'

/** What the save needs from the editor: its value, read the way this module reads it. */
export type SaveTextSource = Pick<Monaco.editor.IStandaloneCodeEditor, 'getValue'>

export function editorSaveText(editor: SaveTextSource): string {
  return editor.getValue({ preserveBOM: true, lineEnding: '' })
}
