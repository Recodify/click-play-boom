# Release Notes

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
