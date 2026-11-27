/**
 * MCP management as a left-sidebar panel: the same settings section, wrapped in
 * a page shell that owns the title, the padding and the scroll container (the
 * `main` seat gives the occupant a full-height column and no chrome of its own).
 */
import type { ReactNode } from 'react'
import { McpSettingsSection, type McpSettingsSectionProps } from './McpSettingsSection.tsx'
import css from './McpPage.module.css'

/**
 * Render the MCP page in the central column.
 * @param props - The main-slot props (store, locale and the injected face).
 */
export function McpPage(props: McpSettingsSectionProps): ReactNode {
  const t = props.t
  return (
    <div className={css.page}>
      <div className={css.inner}>
        <header className={css.header}>
          <h1 className={css.title}>{t('pageTitle')}</h1>
          <p className={css.subtitle}>{t('pageSubtitle')}</p>
        </header>
        <McpSettingsSection {...props} />
      </div>
    </div>
  )
}
