/**
 * Left-sidebar rail icon for the MCP panel (a plug: connector + prongs).
 * Sized by the owner: `sidebar.panellist` passes the row's square edge.
 */
import type { JSX } from 'react'

/**
 * Render the panel glyph in `currentColor`.
 * @param props - `size` is the request edge in pixels.
 */
export function McpIcon(props: { size?: number; active?: boolean }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <rect x="3.2" y="4.5" width="9.6" height="5.2" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 9.7v2.1a2 2 0 0 0 2 2h1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
