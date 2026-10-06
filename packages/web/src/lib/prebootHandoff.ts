/** Pure guard for the HTML → React loader hand-off. */
export function shouldReleasePreboot(state: { reactCommitted: boolean; firstPainted: boolean }): boolean {
  return state.reactCommitted && state.firstPainted
}

