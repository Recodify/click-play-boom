# Release Notes

## client 2026.07.08.2

- Fixed query editor syntax-highlight backdrop alignment so native caret and keyboard selection stay on the same lines as the visible highlighted SQL.
- Made syntax highlighting color-only for keywords/comments to avoid bold/italic font metrics drifting from the underlying textarea.

## client 2026.07.08.1

- Added on-demand table-list loading for database-scoped schema autocomplete, so typing `database.` can suggest tables/views/dictionaries before the database has been expanded in the navigator.
- Reused the navigator schema cache for autocomplete-loaded tables so later navigator expansion does not refetch the same table list or force the database open.
