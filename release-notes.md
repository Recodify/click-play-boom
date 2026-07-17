# Release Notes

## client 2026.07.17.1

- Fixed Ctrl/Cmd+Enter executing a stale cached query range when a selection drag ended outside the editor; focused execution now reads the exact live native selection.
- Kept deliberate editor blur on full-script execution and preserved exact selected-text execution through Run-button clicks.

## client 2026.07.16.1

- Added source-connection generation of batched Schema compatibility inserts from native materialized-view target metadata.
- Added a compatibility-table database prompt and kept generated inserts selected for review and explicit execution on the older destination connection.

## client 2026.07.15.3

- Added lazy, cached ClickHouse formatting for Schema CREATE statements with raw-query fallback.
- Added a dedicated top-level GROUP BY summary for materialized and refreshable materialized views.
- Made Schema definition blocks wider and horizontally scrollable instead of breaking SQL tokens.

## client 2026.07.15.2

- Moved Schema compatibility-table generation to the connection menu with existing- and new-database modes.
- Persisted each connection's selected compatibility database and made Schema query that exact table.

## client 2026.07.15.1

- Replaced full Schema node engine names with compact badges so table names receive more header space.
- Added full ClickHouse engine names as engine-badge hover titles.

## client 2026.07.14.1

- Made Schema tolerate older ClickHouse versions without `system.tables.target_database` / `target_table`.
- Added optional `click_play_boom.schema_mv_targets` compatibility-table support and a database context-menu DDL generator.

## client 2026.07.10.15

- Made Schema database filtering a compact multiselect dropdown.
- Made Schema search/database filters re-layout the visible graph with more generous spacing.

## client 2026.07.10.14

- Added a native Schema workspace that ports the ClickHouse core schema visualizer into the SPA using the active connection credentials.
- Added Schema tab/URL state, an Open schema connection-menu action, graph search/filter controls, details panel, zoom, and load heat-map controls.

## client 2026.07.10.13

- Changed Dashboard reload to a compact icon action and added more spacing around toolbar dividers.

## client 2026.07.10.12

- Added subtle Dashboard toolbar dividers between the selector, range controls, and bucket control.

## client 2026.07.10.11

- Removed the Dashboard range label and renamed the rounding control to `Bucket` to reflect its time-bucket interval behavior.
- Lightened the Dashboard bucket unit text.

## client 2026.07.10.10

- Replaced the Dashboard reset zoom button with a clearer custom reset-magnifier SVG.

## client 2026.07.10.9

- Changed the Dashboard reset zoom icon to a clearer magnifier/back-arrow glyph.
- Hardened Dashboard and active connection toolbar wrapping so zoomed layouts do not overlap controls.

## client 2026.07.10.8

- Replaced the Dashboard reset zoom glyph with a clearer magnifier/reset icon.

## client 2026.07.10.7

- Reworked the Dashboard control bar so selector, range/rounding controls, reload, and dashboard actions sit in one intentional toolbar.
- Removed the params `Ok` action and made range, rounding, and custom param changes auto-apply on change.
- Moved add chart, edit JSON, and reset zoom into compact right-aligned icon buttons.

## client 2026.07.10.6

- Fixed the Dashboard JSON editor layout so its textarea fills the main dashboard workspace instead of collapsing to a thin row.

## client 2026.07.10.5

- Kept dashboard chart drag shadows at the chart's measured size so wide or expanded charts stay connected to the pointer while moving.

## client 2026.07.10.4

- Replaced the Dashboard picker with a native select control that reloads the dashboard immediately on selection.
- Moved Dashboard zoom reset to a single toolbar action and made double-click/Escape reset all synced charts.
- Changed chart maximize to expand height in place instead of reshuffling the dashboard grid under the cursor.
- Added `view=query|dashboard` URL state so refreshes and bookmarks preserve the active workspace.

## client 2026.07.10.3

- Fixed the Dashboard JSON editor being visible by default and disabled Apply while its JSON is empty or invalid.
- Moved dashboard chart titles and actions into a dedicated header so plots no longer overlap chart chrome.
- Added dashboard chart zoom reset via toolbar button, double-click, and Escape for the active chart.
- Replaced raw dashboard range params with Last/Absolute range controls while keeping custom dashboard params editable.

## client 2026.07.10.2

- Added a native Dashboard workspace that loads ClickHouse dashboard definitions through the active saved connection.
- Moved the connection context menu "Open dashboard" action into the SPA instead of opening the server-hosted dashboard.
- Preserved transient dashboard add/edit/delete/reorder and mass JSON editing flows without adding dashboard persistence.

## client 2026.07.10.1

- Added focused Playwright browser tests that assert selected and full-script query runs submit the intended HTTP POST bodies.
- Added the query submission safety test command to CI and development docs.

## client 2026.07.09.6

- Added a repo-managed pre-commit hook that regenerates and stages `click-play-boom.html` automatically during local commits.
- Added `npm run hooks:install` and documented the one-time setup for the generated artifact workflow.

## client 2026.07.09.5

- Added a GitHub Actions build check so stale generated `click-play-boom.html` output fails CI.
- Marked `click-play-boom.html` as generated and documented the source-versus-artifact workflow in the README.

## client 2026.07.09.4

- Split the development source into `src/` HTML, CSS, script, template, and asset files while keeping `click-play-boom.html` as the generated single-file artifact.
- Added a Node-based single-file build/check tool with `npm run build` and `npm run build:check`.

## client 2026.07.09.3

- Replaced ambiguous snippet toolbar glyphs with clearer folder, bookmark, import, and export icons.
- Added snippet folder and snippet move up/down actions with persisted ordering.
- Preserved snippet ordering through collection export and import.

## client 2026.07.09.2

- Added snippet collection export and import controls to the Snippets panel.
- Imported snippet collections merge into the schema-versioned snippet store and generate fresh ids when imported records collide.

## client 2026.07.09.1

- Moved saved snippets and connections to schema-versioned v2 localStorage envelopes.
- Added timestamp merge and tombstone handling so stale tabs do not overwrite newer snippet or connection-manager state.
- Block saves when a newer localStorage schema is detected instead of overwriting future state.

## client 2026.07.08.4

- Fixed result copy menu labels being ellipsized by forcing the shared context menu to size from its contents before viewport clamping.

## client 2026.07.08.3

- Reduced large snippet insertion jank by suppressing duplicate programmatic input highlighting work and deferring syntax highlighting for large inserted text.
- Kept result copy popovers inside the viewport by right-aligning them to the copy button and adding viewport-sized menu bounds.

## client 2026.07.08.2

- Fixed query editor syntax-highlight backdrop alignment so native caret and keyboard selection stay on the same lines as the visible highlighted SQL.
- Made syntax highlighting color-only for keywords/comments to avoid bold/italic font metrics drifting from the underlying textarea.

## client 2026.07.08.1

- Added on-demand table-list loading for database-scoped schema autocomplete, so typing `database.` can suggest tables/views/dictionaries before the database has been expanded in the navigator.
- Reused the navigator schema cache for autocomplete-loaded tables so later navigator expansion does not refetch the same table list or force the database open.
