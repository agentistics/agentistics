/** Header control: close both open left menus; otherwise retain the sessions-list toggle. */
export function headerLeftMenus(areasOpen: boolean, sessionsCollapsed: boolean) {
  return { areasOpen: areasOpen && !sessionsCollapsed ? false : areasOpen, sessionsCollapsed: !sessionsCollapsed }
}
