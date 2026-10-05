import { useIsMobile } from '../../hooks/useIsMobile'
import { boardCopy, type Lang } from './copy'
import { PanelMenu, menuRowStyle } from './PickerMenu'
import { viewSegment } from './ViewBar'

/**
 * "Show all / Hide empty groups" — one control for the board's view settings and the table's, so the two
 * say it in the same words. A VIEW choice (`boardPrefs.hideEmpty`): the groups a person picked are kept.
 */
export function EmptyGroupsMenu({ hide, onChange, lang }: { hide: boolean; onChange: (hide: boolean) => void; lang: Lang }) {
  const isMobile = useIsMobile()
  const c = boardCopy(lang).viewBar
  return (
    <PanelMenu
      title={c.emptyGroups}
      width={210}
      triggerStyle={viewSegment(isMobile, hide)}
      render={close => (
        <>
          <button type="button" data-empty-groups="show" onClick={() => { close(); onChange(false) }} style={menuRowStyle(isMobile, !hide)}>{c.showAll}</button>
          <button type="button" data-empty-groups="hide" onClick={() => { close(); onChange(true) }} style={menuRowStyle(isMobile, hide)}>{c.hideEmpty}</button>
        </>
      )}
    >{hide ? c.hideEmpty : c.emptyGroups}</PanelMenu>
  )
}
