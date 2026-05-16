import { Plug } from 'lucide-react'
import { useWorkspace } from '../tabs/store'
import { getFocusedTab } from '../tabs/types'
import { SidebarRow } from './SidebarRow'

/**
 * Legacy Connectors sidebar.
 *
 * The pre-Workspace push delivery surfaces — Telegram bot, MCP Ask,
 * Web SSE channel routing. Lives in the ActivityBar's Legacy section
 * because the broader connector architecture is slated for rework as
 * Workspace becomes the load-bearing surface; the existing connector
 * config still functions and remains the path for Telegram / MCP Ask
 * users until the replacement lands.
 *
 * Sidebar opens the existing `settings/connectors` page (no separate
 * ViewSpec needed — the page already lives under settings).
 */
export function ConnectorsLegacySidebar() {
  const focused = useWorkspace((state) => getFocusedTab(state)?.spec)
  const isActive =
    focused?.kind === 'settings' && focused.params.category === 'connectors'
  const openOrFocus = useWorkspace((state) => state.openOrFocus)

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-[11px] text-text-muted/70 leading-relaxed border-b border-border/40">
        Legacy push-delivery surfaces — Telegram bot, MCP Ask, webhook
        routing. Slated for rework as Workspace replaces global chat;
        the current config still works for now.
      </div>
      <div className="py-0.5">
        <SidebarRow
          label={
            <span className="flex items-center gap-2">
              <Plug size={14} strokeWidth={1.8} className="shrink-0" />
              <span>Connectors</span>
            </span>
          }
          active={isActive}
          onClick={() =>
            openOrFocus({ kind: 'settings', params: { category: 'connectors' } })
          }
        />
      </div>
    </div>
  )
}
