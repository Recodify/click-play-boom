# click-play-boom

`click-play-boom` is a single-file ClickHouse HTTP query interface.

![dark theme query editor](./imgs/dark.png)

A rework of the ClickHouse Play page that keeps the same lightweight shape:

- one self-contained deployable HTML file
- split source files for development
- no framework or runtime package dependencies
- no external resources loaded on startup.

The rework focuses on making the browser UI useful for real query work rather than only one-off single-statement experiments.


## What It Does

- Runs ClickHouse queries over the HTTP interface.
- Executes all statements in the editor, or only the currently selected text.
- Splits multi-statement scripts using the embedded ClickHouse lexer when WebAssembly is available.
- Shows each executed statement in its own result tab.
- Keeps an action history for executed statements and their status.
- Manages multiple saved connections in browser local storage.
- Shows the active connection clearly above the editor.
- Loads schemas through a navigator with databases, tables, dictionaries, views, materialized views, and columns.
- Inserts database, table, dictionary, view, and column names from the navigator into the query editor.
- Provides table actions to generate common SQL:
  - `SELECT *`
  - `SELECT` with all column names
  - `SELECT count(*)`
  - `SELECT formatReadableQuantity(count(*))`
  - `SHOW TABLE`
  - `system.tables` lookup
  - `system.query_log` lookup
  - `INSERT` template
  - `DROP TABLE` / `DROP DICTIONARY` / `DROP VIEW`
- Provides numeric column actions to generate quantile/min/avg/max stats SQL.
- Stores query snippets in local folders.
- Supports result downloads in ClickHouse formats such as CSV, TSV, JSON, JSONLines, Parquet, Markdown, or a custom format.
- Can optionally write preview results to ClickHouse query cache so a later download can reuse the same result.
- Supports compact editor mode, resizable sidebar, and light/dark themes.

## Files

- [`click-play-boom.html`](./click-play-boom.html) is the generated, committed app artifact. Open or deploy this file.
- [`src/`](./src/) contains the editable source HTML, CSS, JavaScript, templates, and embedded assets.
- [`tools/build-single-file.mjs`](./tools/build-single-file.mjs) assembles the source files into the root HTML artifact.

Edit files under `src/`, then regenerate the artifact:

```bash
npm run build
```

Install the repo-managed pre-commit hook once to regenerate and stage the artifact automatically during local commits:

```bash
npm run hooks:install
```

Check that the committed artifact is fresh:

```bash
npm run build:check
```

## Usage

Open [`click-play-boom.html`](./click-play-boom.html) in a browser.

By default, when opened from the filesystem, it targets:

```text
http://localhost:8123/
```

When served over HTTP, it defaults to the same origin that served the page. You can also pass connection details in the URL:

```text
click-play-boom.html?url=http%3A%2F%2Flocalhost%3A8123%2F&user=default
```

The app sends queries with `add_http_cors_header=1`, so the target ClickHouse server must be reachable from the browser and allow the browser request to complete.

## Running Queries

Use the editor as a SQL script buffer.

- Press `Ctrl+Enter` or `Cmd+Enter` to run.
- If text is selected, only the selected text is executed.
- If nothing is selected, all statements in the editor are executed.
- Each statement is run sequentially and receives its own result tab.
- Press the run button while a query is active to stop after the current request is cancelled.

The current implementation uses ClickHouse lexer tokenization for statement splitting when the browser supports WebAssembly. If WebAssembly is unavailable, it falls back to simple semicolon splitting.

## Navigator

The left navigator stores connections locally and lazy-loads schema information from ClickHouse system tables.

- Select a connection to make it active and load databases.
- Expand databases to load tables, dictionaries, and views.
- Expand tables to load columns.
- Use the filter box to search connections and loaded schema.
- Use database/table context menus and column double-clicks to insert names into the editor.
- Use table context menus to generate SQL into the editor.
- Use the connection context menu to edit/delete a connection or open the ClickHouse dashboard for that server.

Connection details are stored in browser local storage, including passwords. Treat this as a local development convenience, not a secure secret store.

## Snippets

The snippets tab stores reusable queries in browser local storage.

- Create folders.
- Save the current editor contents.
- Load snippets back into the editor by appending, inserting at the cursor, or replacing the editor contents.
- Choose the default snippet insertion mode from the snippets panel.
- Append, insert, replace, rename, update, or delete snippets through their context menus.

## Downloads

After a successful query, use the download control to rerun the active result query with a download-oriented output format. The download filename can be provided manually, or left blank to derive a name from the first `FROM` table in the query.

Supported presets are:

- `CSVWithNames` shown as `CSV (with headers)`
- `TSVWithNames` shown as `TSV (with headers)`
- `JSON`
- `Parquet`
- `Markdown`

Additional ClickHouse formats are available in the dropdown, and you can still enter any ClickHouse format name manually. Downloaded files use normalized file extensions such as `.csv`, `.tsv`, `.jsonl`, `.parquet`, and `.md`.

When "Reuse cached result for download" is enabled, preview queries are written to ClickHouse query cache and downloads are requested with query-cache reads enabled. This is useful for large or expensive results, but it depends on server support and query-cache settings.

## Browser State

The app stores preferences and local data in `localStorage`, including:

- saved connections
- active connection
- navigator expansion state
- sidebar width/collapsed state
- active sidebar tab
- query snippets
- compact editor preference
- download cache preference
- theme preference


## Development

The project keeps the original ClickHouse Play deployment constraint of being a standalone HTML document:

- CSS is authored under `src/styles/` and embedded into the generated page.
- JavaScript is authored under `src/scripts/` and embedded into the generated page.
- Templates and assets are authored under `src/templates/` and `src/assets/`.
- No npm install is required.
- No bundler is required.
- No external scripts, fonts, or images are loaded during startup.

This keeps deployment simple: replace or serve the HTML file wherever you want the query UI to live.

Useful development checks:

```bash
npm run hooks:install
npm run build
npm run build:check
node --check tools/build-single-file.mjs
find src/scripts -name '*.js' -print0 | xargs -0 -n1 node --check
```

## Lineage

A fork of https://github.com/ClickHouse/ClickHouse/blob/v26.3.3.20-lts/programs/server/play.html

## Status

The app is usable as a local/development ClickHouse HTTP query UI. Known rough edges from the current implementation include:

- long query text can still take up too much vertical space in result summaries
- very wide result tables can make horizontal scrolling awkward
- result copy-to-clipboard options are still pending
- session/server settings management is still future work
- saved/admin query panels are still future work
