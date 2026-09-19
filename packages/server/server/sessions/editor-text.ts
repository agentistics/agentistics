/**
 * editor-text.ts — whether a file's bytes can be handed to an EDITOR at all, decided once. Pure.
 *
 * The Studio's read path used to be `buf.toString('utf8')` behind a NUL-byte sniff, and the save
 * path writes the editor's string back as UTF-8. Those two are each other's inverse ONLY for bytes
 * that already were valid UTF-8. A Latin-1 / cp1252 file carries no NUL, so the sniff called it
 * text, `toString` replaced every byte it could not decode with U+FFFD, the editor offered a live
 * Save, and the save wrote the replacement characters over the original bytes — with the mtime
 * matching, so no conflict, no refusal, and a strip saying "Saved". Measured: `caf\xE9\n` came back
 * as `63 61 66 ef bf bd 0a`.
 *
 * So the decode is STRICT (`fatal: true`): a buffer that is not valid UTF-8 yields `null`, and the
 * caller REFUSES — this module's standing rule is refuse, never repair. There is deliberately no
 * transcoding path: guessing an encoding is guessing which bytes the save will write, and a wrong
 * guess is the same silent corruption by another door.
 *
 * `ignoreBOM: true` KEEPS a leading byte-order mark in the string rather than consuming it. Every
 * string this returns re-encodes to exactly the bytes it came from — that is the whole contract of
 * THIS module, and `editor-text.test.ts` asserts it over the bytes.
 *
 * **What that does and does not promise about a save from the Studio.** The server half is exact:
 * the string it hands out, PUT back unchanged, writes the same bytes. The editor in between is a
 * second party with rules of its own, and two of them touch bytes nobody edited:
 *
 *  - Monaco holds a BOM BESIDE the text, not in it, so a bare `getValue()` drops it. The web save
 *    reads through `packages/web/src/lib/editorSaveText.ts` (`preserveBOM: true`), and
 *    `editorSaveText.test.ts` drives a BOM file through this route, a real Monaco text model and back,
 *    asserting the bytes on disk.
 *  - **STATED LIMIT: mixed line endings are normalised.** Monaco's model holds one EOL sequence, so a
 *    file mixing `\r\n`, `\n` and `\r` is rewritten to one of them the moment it is opened, and a
 *    save writes that. A file with one consistent ending round-trips byte-identically; one with mixed
 *    endings does not, and no route on this side can repair what the editor never held.
 */
export function decodeUtf8Lossless(buf: Uint8Array): string | null {
  try {
    // A fresh decoder per call: a fatal decoder that has thrown is not a thing to keep state in.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return null
  }
}
