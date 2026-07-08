# Release Notes

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
