/**
 * Glass is part of the product, not a setting: `data-glass="on"` is always written on <html>, and
 * every glass rule in `index.css` keys on it. There is no switch and no stored choice — a device
 * that once turned the old experimental option off (`agentistics-glass` = '0') is simply ignored.
 */
export function applyGlass(root: HTMLElement = document.documentElement): void {
  root.dataset.glass = 'on'
}
