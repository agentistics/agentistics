/**
 * codeBoxes.ts — the editing rules of the 6-box code input (`components/CodeBoxes.tsx`). PURE.
 *
 * The value is a string of DIGITS with no holes ("12" means boxes 1–2 filled): a box after the last
 * filled one types into the first empty box, so a code can never be half in box 1 and half in box 5.
 *  - typing writes at the box (or the first empty one) and moves on;
 *  - several digits at once (a paste, an iOS "one-time-code" autofill landing in box 1) fill from that
 *    box; a whole code fills every box, wherever it lands;
 *  - Backspace on a filled box clears it and stays; on an empty box it clears the previous one and goes
 *    back — the rule every code field on a phone follows.
 */
export const CODE_LENGTH = 6

export interface CodeEdit { value: string; focus: number }

/** PURE. Digits typed or pasted into box `index`. Non-digits are ignored (a pasted "123 456" is the code). */
export function typeAt(value: string, index: number, input: string, length = CODE_LENGTH): CodeEdit {
  const digits = input.replace(/\D/g, '')
  const cur = value.replace(/\D/g, '').slice(0, length)
  if (!digits) return { value: cur, focus: clamp(index, length) }
  if (digits.length >= length) return { value: digits.slice(0, length), focus: length - 1 }
  const start = Math.min(Math.max(0, index), cur.length)
  const arr = cur.split('')
  for (let k = 0; k < digits.length && start + k < length; k++) arr[start + k] = digits[k]!
  const next = arr.join('').slice(0, length)
  return { value: next, focus: clamp(start + digits.length, length) }
}

/** PURE. Backspace in box `index`. */
export function eraseAt(value: string, index: number): CodeEdit {
  if (index < value.length && index >= 0) return { value: value.slice(0, index) + value.slice(index + 1), focus: index }
  const prev = Math.min(index, value.length) - 1
  if (prev < 0) return { value, focus: 0 }
  return { value: value.slice(0, prev) + value.slice(prev + 1), focus: prev }
}

/**
 * PURE. What a box's `onChange` actually typed: the box shows its one digit and selects it on focus, but
 * a browser that kept the caret after it hands back "old+new" — the new digit is what is not the old one.
 */
export function typedIn(raw: string, old: string | undefined): string {
  if (raw.length === 2 && old) {
    if (raw[0] === old) return raw.slice(1)
    if (raw[1] === old) return raw.slice(0, 1)
  }
  return raw
}

const clamp = (i: number, length: number) => Math.min(Math.max(0, i), length - 1)
