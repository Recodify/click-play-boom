function formatClickHouseIdentifier(name) {
    const identifier = String(name || '');
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
        ? identifier
        : `\`${identifier.replace(/`/g, '``')}\``;
}

function formatQualifiedIdentifier(database, name) {
    return `${formatClickHouseIdentifier(database)}.${formatClickHouseIdentifier(name)}`;
}

function normaliseAutocompleteIdentifier(identifier_part) {
    return stripClickHouseIdentifierQuotes(identifier_part || '').trim();
}

function splitAutocompleteIdentifierPath(path) {
    const parts = [];
    let quote = '';
    let part_start = 0;

    for (let i = 0; i < path.length; ++i) {
        const ch = path[i];
        if (quote) {
            if (ch == quote) {
                if (path[i + 1] == quote) {
                    ++i;
                } else {
                    quote = '';
                }
            }
            continue;
        }

        if (ch == '`' || ch == '"') {
            quote = ch;
            continue;
        }

        if (ch == '.') {
            parts.push(path.substring(part_start, i));
            part_start = i + 1;
        }
    }

    parts.push(path.substring(part_start));
    return parts;
}

function getAutocompleteContext() {
    const cursor = query_area.selectionStart ?? query_area.value.length;
    const before_cursor = query_area.value.substring(0, cursor);
    const identifier_source = '(?:`(?:``|[^`])*`|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*)';
    const prefix_source = '(?:`(?:``|[^`])*`?|"(?:""|[^"])*"?|[A-Za-z_][A-Za-z0-9_$]*|[A-Za-z0-9_$]+)';
    const match = before_cursor.match(new RegExp(`((?:${identifier_source}\\.)*)(${prefix_source})?$`));
    const matched_text = match ? match[0] : '';
    const scope_text = match ? match[1] || '' : '';
    const prefix_text = match ? match[2] || '' : '';
    const scope_parts = splitAutocompleteIdentifierPath(scope_text)
        .map(normaliseAutocompleteIdentifier)
        .filter(Boolean);
    const statement = getAutocompleteStatement(cursor);
    const statement_refs = getAutocompleteStatementRefs(statement.text);

    return {
        cursor,
        prefix: normaliseAutocompleteIdentifier(prefix_text),
        replace_start: cursor - prefix_text.length,
        scope_parts,
        scope_key: scope_parts.join('\n'),
        context_start: cursor - matched_text.length,
        statement,
        statement_refs,
        statement_key: `${statement.start}:${statement.end}:${statement_refs.map(ref => `${ref.database}.${ref.table}:${ref.alias || ''}`).join('|')}`
    };
}

function getLoadedDatabaseNames() {
    return schema_state.databases
        .map(database_info => database_info.database)
        .filter(Boolean);
}

function findLoadedDatabaseName(database_name) {
    const databases = getLoadedDatabaseNames();
    const exact_match = databases.find(database => database == database_name);
    if (exact_match) {
        return exact_match;
    }

    const lower_database_name = database_name.toLowerCase();
    return databases.find(database => database.toLowerCase() == lower_database_name) || '';
}

function getLoadedTables(database_name) {
    return schema_state.tables[database_name] || [];
}

function findLoadedTable(database_name, table_name) {
    const tables = getLoadedTables(database_name);
    const exact_match = tables.find(table => table.table == table_name);
    if (exact_match) {
        return exact_match;
    }

    const lower_table_name = table_name.toLowerCase();
    return tables.find(table => table.table.toLowerCase() == lower_table_name) || null;
}

function findLoadedTablesByName(table_name) {
    const matches = [];
    const lower_table_name = table_name.toLowerCase();

    for (const database of getLoadedDatabaseNames()) {
        const table = getLoadedTables(database).find(candidate => candidate.table.toLowerCase() == lower_table_name);
        if (table) {
            matches.push({ database, table });
        }
    }

    return matches;
}

function getLoadedColumns(database_name, table_name) {
    return schema_state.columns[getSchemaTableKey(database_name, table_name)] || [];
}

const AUTOCOMPLETE_TABLE_REF_START_KEYWORDS = new Set(['FROM', 'JOIN']);
const AUTOCOMPLETE_ALIAS_STOP_WORDS = new Set([
    'ALL', 'ANY', 'ARRAY', 'ASOF', 'CROSS', 'FINAL', 'FULL', 'GLOBAL', 'INNER', 'LEFT',
    'LIMIT', 'ON', 'ORDER', 'OUTER', 'PREWHERE', 'RIGHT', 'SAMPLE', 'SEMI', 'SETTINGS',
    'UNION', 'USING', 'WHERE', 'WINDOW', 'GROUP', 'HAVING', 'FORMAT', 'JOIN'
]);

function getAutocompleteStatement(cursor) {
    const text = query_area.value;
    let start = 0;
    let end = text.length;
    let quote = '';
    let line_comment = false;
    let block_comment = false;

    for (let i = 0; i < text.length; ++i) {
        const ch = text[i];
        const next = text[i + 1];

        if (line_comment) {
            if (ch == '\n') {
                line_comment = false;
            }
            continue;
        }

        if (block_comment) {
            if (ch == '*' && next == '/') {
                block_comment = false;
                ++i;
            }
            continue;
        }

        if (quote) {
            if (ch == '\\' && quote == '\'' && next) {
                ++i;
            } else if (ch == quote) {
                if (next == quote) {
                    ++i;
                } else {
                    quote = '';
                }
            }
            continue;
        }

        if (ch == '-' && next == '-') {
            line_comment = true;
            ++i;
            continue;
        }

        if (ch == '/' && next == '*') {
            block_comment = true;
            ++i;
            continue;
        }

        if (ch == '\'' || ch == '"' || ch == '`') {
            quote = ch;
            continue;
        }

        if (ch == ';') {
            if (i < cursor) {
                start = i + 1;
            } else {
                end = i;
                break;
            }
        }
    }

    return {
        start,
        end,
        text: text.substring(start, end)
    };
}

function readAutocompleteQuotedIdentifier(statement, start, quote) {
    let result = '';
    let i = start + 1;

    while (i < statement.length) {
        const ch = statement[i];
        if (ch == quote) {
            if (statement[i + 1] == quote) {
                result += quote;
                i += 2;
                continue;
            }

            return { value: result, end: i + 1 };
        }

        result += ch;
        ++i;
    }

    return { value: result, end: i };
}

function tokenizeAutocompleteStatement(statement) {
    const tokens = [];

    for (let i = 0; i < statement.length;) {
        const ch = statement[i];
        const next = statement[i + 1];

        if (/\s/.test(ch)) {
            ++i;
            continue;
        }

        if (ch == '-' && next == '-') {
            i += 2;
            while (i < statement.length && statement[i] != '\n') {
                ++i;
            }
            continue;
        }

        if (ch == '/' && next == '*') {
            i += 2;
            while (i < statement.length && !(statement[i] == '*' && statement[i + 1] == '/')) {
                ++i;
            }
            i = Math.min(statement.length, i + 2);
            continue;
        }

        if (ch == '\'') {
            ++i;
            while (i < statement.length) {
                if (statement[i] == '\\' && statement[i + 1]) {
                    i += 2;
                } else if (statement[i] == '\'') {
                    if (statement[i + 1] == '\'') {
                        i += 2;
                    } else {
                        ++i;
                        break;
                    }
                } else {
                    ++i;
                }
            }
            continue;
        }

        if (ch == '`' || ch == '"') {
            const quoted = readAutocompleteQuotedIdentifier(statement, i, ch);
            tokens.push({
                type: 'identifier',
                value: quoted.value,
                upper: quoted.value.toUpperCase()
            });
            i = quoted.end;
            continue;
        }

        if (/[A-Za-z_]/.test(ch)) {
            const start = i;
            ++i;
            while (i < statement.length && /[A-Za-z0-9_$]/.test(statement[i])) {
                ++i;
            }

            const value = statement.substring(start, i);
            tokens.push({
                type: 'identifier',
                value,
                upper: value.toUpperCase()
            });
            continue;
        }

        if (ch == '.' || ch == ',' || ch == '(' || ch == ')') {
            tokens.push({ type: ch, value: ch, upper: ch });
        }
        ++i;
    }

    return tokens;
}

function readAutocompleteIdentifierPath(tokens, start_index) {
    if (tokens[start_index]?.type != 'identifier') {
        return null;
    }

    const parts = [tokens[start_index].value];
    let index = start_index + 1;

    while (tokens[index]?.type == '.' && tokens[index + 1]?.type == 'identifier') {
        parts.push(tokens[index + 1].value);
        index += 2;
    }

    return { parts, end_index: index };
}

function getCurrentLoadedDatabaseName() {
    const current_database = schema_state.databases.find(database_info =>
        database_info.current === true || database_info.current === 1 || database_info.current === '1');
    return current_database?.database || '';
}

function resolveAutocompleteTablePath(parts) {
    if (!parts.length) {
        return null;
    }

    if (parts.length >= 2) {
        const database = findLoadedDatabaseName(parts[parts.length - 2]);
        if (!database) {
            return null;
        }

        const table = findLoadedTable(database, parts[parts.length - 1]);
        return table ? { database, table: table.table } : null;
    }

    const table_name = parts[0];
    const current_database = getCurrentLoadedDatabaseName();
    if (current_database) {
        const current_database_table = findLoadedTable(current_database, table_name);
        if (current_database_table) {
            return { database: current_database, table: current_database_table.table };
        }
    }

    const table_matches = findLoadedTablesByName(table_name);
    if (table_matches.length == 1) {
        return {
            database: table_matches[0].database,
            table: table_matches[0].table.table
        };
    }

    return null;
}

function readAutocompleteTableAlias(tokens, start_index) {
    let index = start_index;
    if (tokens[index]?.upper == 'FINAL') {
        ++index;
    }

    if (tokens[index]?.upper == 'AS' && tokens[index + 1]?.type == 'identifier') {
        return tokens[index + 1].value;
    }

    if (tokens[index]?.type == 'identifier' && !AUTOCOMPLETE_ALIAS_STOP_WORDS.has(tokens[index].upper)) {
        return tokens[index].value;
    }

    return '';
}

function getAutocompleteStatementRefs(statement_text) {
    const tokens = tokenizeAutocompleteStatement(statement_text);
    const refs = [];

    for (let i = 0; i < tokens.length; ++i) {
        if (tokens[i].type != 'identifier' || !AUTOCOMPLETE_TABLE_REF_START_KEYWORDS.has(tokens[i].upper)) {
            continue;
        }

        const path = readAutocompleteIdentifierPath(tokens, i + 1);
        if (!path) {
            continue;
        }

        const scope = resolveAutocompleteTablePath(path.parts);
        if (!scope) {
            continue;
        }

        refs.push({
            database: scope.database,
            table: scope.table,
            alias: readAutocompleteTableAlias(tokens, path.end_index)
        });
    }

    return refs;
}

function dedupeAutocompleteTableScopes(scopes) {
    const seen = new Set();
    const result = [];

    for (const scope of scopes) {
        if (!scope) {
            continue;
        }

        const key = getSchemaTableKey(scope.database, scope.table);
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(scope);
    }

    return result;
}

function findAutocompleteStatementScope(context, identifier) {
    const lower_identifier = identifier.toLowerCase();
    const alias_matches = context.statement_refs.filter(ref => (ref.alias || '').toLowerCase() == lower_identifier);
    if (alias_matches.length == 1) {
        return {
            database: alias_matches[0].database,
            table: alias_matches[0].table,
            alias: alias_matches[0].alias
        };
    }

    const table_matches = context.statement_refs.filter(ref => ref.table.toLowerCase() == lower_identifier);
    const unique_table_matches = dedupeAutocompleteTableScopes(table_matches);
    if (unique_table_matches.length == 1) {
        return unique_table_matches[0];
    }

    return null;
}

function getAutocompleteColumnScopes(context) {
    if (context.scope_parts.length) {
        return dedupeAutocompleteTableScopes([resolveAutocompleteTableScope(context)]);
    }

    return dedupeAutocompleteTableScopes(context.statement_refs);
}

function resolveAutocompleteTableScope(context) {
    if (context.scope_parts.length == 1) {
        if (findLoadedDatabaseName(context.scope_parts[0])) {
            return null;
        }

        const statement_scope = findAutocompleteStatementScope(context, context.scope_parts[0]);
        if (statement_scope) {
            return statement_scope;
        }

        const scope = resolveAutocompleteTablePath([context.scope_parts[0]]);
        if (scope) {
            return scope;
        }

        return null;
    }

    if (context.scope_parts.length < 2) {
        return null;
    }

    const database = findLoadedDatabaseName(context.scope_parts[0]);
    if (!database) {
        return null;
    }

    const table = findLoadedTable(database, context.scope_parts[1]);
    if (!table) {
        return null;
    }

    return {
        database,
        table: table.table
    };
}

function getAutocompleteTableLoadDatabase(context) {
    if (!context.scope_parts.length) {
        return '';
    }

    return findLoadedDatabaseName(context.scope_parts[0]);
}

function getAutocompleteTableLoadKey(database) {
    return `${current_connection_id || ''}:${database}`;
}

function isAutocompleteTableLoadPending(database) {
    return !!schema_state.loading_tables[database]
        || !!autocomplete_table_loads[getAutocompleteTableLoadKey(database)];
}

function ensureAutocompleteTablesLoaded(context) {
    const database = getAutocompleteTableLoadDatabase(context);
    if (!database || schema_state.tables[database]) {
        return false;
    }

    if (isAutocompleteTableLoadPending(database)) {
        return true;
    }

    const request_connection_id = current_connection_id;
    const load_key = getAutocompleteTableLoadKey(database);
    autocomplete_table_loads[load_key] = true;

    loadTables(url_elem.value, user_elem.value, password_elem.value, database)
        .then(() => {
            delete autocomplete_table_loads[load_key];
            if (request_connection_id == current_connection_id
                && schema_state.connection_id == request_connection_id) {
                refreshAutocompleteFromEditor();
            }
        })
        .catch(() => {
            delete autocomplete_table_loads[load_key];
            if (request_connection_id == current_connection_id
                && schema_state.connection_id == request_connection_id) {
                delete schema_state.loading_tables[database];
                schema_state.table_messages[database] = 'Failed to load tables.';
                ++autocomplete_schema_revision;
                renderNavigatorTree();
                refreshAutocompleteFromEditor();
            }
        });

    return true;
}

function isAutocompleteLoadingTables(context) {
    const database = getAutocompleteTableLoadDatabase(context);
    return !!database
        && !schema_state.tables[database]
        && isAutocompleteTableLoadPending(database);
}

function getAutocompleteColumnLoadKey(database, table) {
    return `${current_connection_id || ''}:${getSchemaTableKey(database, table)}`;
}

function isAutocompleteColumnLoadPending(database, table) {
    return !!autocomplete_column_loads[getAutocompleteColumnLoadKey(database, table)];
}

function ensureAutocompleteColumnsLoaded(context) {
    let loading = false;

    for (const scope of getAutocompleteColumnScopes(context)) {
        const cache_key = getSchemaTableKey(scope.database, scope.table);
        if (schema_state.columns[cache_key]) {
            continue;
        }

        const load_key = getAutocompleteColumnLoadKey(scope.database, scope.table);
        if (autocomplete_column_loads[load_key]) {
            loading = true;
            continue;
        }

        const request_connection_id = current_connection_id;
        autocomplete_column_loads[load_key] = true;
        loading = true;

        fetchTableColumns(url_elem.value, user_elem.value, password_elem.value, scope.database, scope.table)
            .then(columns => {
                delete autocomplete_column_loads[load_key];
                if (columns === false
                    || request_connection_id != current_connection_id
                    || schema_state.connection_id != request_connection_id) {
                    refreshAutocompleteFromEditor();
                    return;
                }

                schema_state.columns[cache_key] = columns;
                ++autocomplete_schema_revision;
                refreshAutocompleteFromEditor();
            })
            .catch(() => {
                delete autocomplete_column_loads[load_key];
                refreshAutocompleteFromEditor();
            });
    }

    return loading;
}

function isAutocompleteLoadingColumns(context) {
    return getAutocompleteColumnScopes(context).some(scope =>
        isAutocompleteColumnLoadPending(scope.database, scope.table));
}

function createAutocompleteSuggestion(kind, label, insert_text, detail, rank) {
    return {
        kind,
        label,
        insert_text,
        detail,
        rank,
        search_text: `${label} ${detail || ''}`.toLowerCase()
    };
}

function addDatabaseAutocompleteSuggestions(suggestions) {
    for (const database of getLoadedDatabaseNames()) {
        suggestions.push(createAutocompleteSuggestion(
            'database',
            database,
            formatClickHouseIdentifier(database),
            'database',
            10));
    }
}

function addTableAutocompleteSuggestions(suggestions, database, qualified_insert) {
    for (const table of getLoadedTables(database)) {
        const kind = getSchemaItemKind(table.engine);
        suggestions.push(createAutocompleteSuggestion(
            kind,
            table.table,
            qualified_insert ? formatQualifiedIdentifier(database, table.table) : formatClickHouseIdentifier(table.table),
            qualified_insert ? `${database} ${table.engine || ''}`.trim() : table.engine || database,
            kind == 'table' ? 20 : 25));
    }
}

function addColumnAutocompleteSuggestions(suggestions, database, table, detail_prefix = '', rank = 30) {
    for (const column of getLoadedColumns(database, table)) {
        suggestions.push(createAutocompleteSuggestion(
            'column',
            column.name,
            formatClickHouseIdentifier(column.name),
            `${detail_prefix || `${database}.${table}`} ${column.type || ''}`.trim(),
            rank));
    }
}

function addStatementColumnAutocompleteSuggestions(suggestions, context) {
    for (const ref of context.statement_refs) {
        const detail_prefix = ref.alias
            ? `${ref.alias} ${ref.database}.${ref.table}`
            : `${ref.database}.${ref.table}`;
        addColumnAutocompleteSuggestions(suggestions, ref.database, ref.table, detail_prefix, 5);
    }
}

function collectSchemaAutocompleteSuggestions(context) {
    const suggestions = [];

    if (!context.scope_parts.length) {
        const has_statement_refs = !!context.statement_refs.length;
        addStatementColumnAutocompleteSuggestions(suggestions, context);
        addDatabaseAutocompleteSuggestions(suggestions);
        for (const database of getLoadedDatabaseNames()) {
            addTableAutocompleteSuggestions(suggestions, database, true);
            if (!has_statement_refs) {
                for (const table of getLoadedTables(database)) {
                    addColumnAutocompleteSuggestions(suggestions, database, table.table);
                }
            }
        }
        return suggestions;
    }

    if (context.scope_parts.length == 1) {
        const database = findLoadedDatabaseName(context.scope_parts[0]);
        if (database) {
            addTableAutocompleteSuggestions(suggestions, database, false);
            return suggestions;
        }

        const scope = resolveAutocompleteTableScope(context);
        if (scope) {
            addColumnAutocompleteSuggestions(suggestions, scope.database, scope.table);
        }
        return suggestions;
    }

    const scope = resolveAutocompleteTableScope(context);
    if (scope) {
        addColumnAutocompleteSuggestions(suggestions, scope.database, scope.table);
    }

    return suggestions;
}

function filterAutocompleteSuggestions(suggestions, prefix) {
    const needle = prefix.toLowerCase();
    const ranked = [];

    for (const suggestion of suggestions) {
        const label = suggestion.label.toLowerCase();
        let match_rank = 0;

        if (needle) {
            if (label.startsWith(needle)) {
                match_rank = 0;
            } else if (suggestion.search_text.startsWith(needle)) {
                match_rank = 1;
            } else if (suggestion.search_text.includes(needle)) {
                match_rank = 2;
            } else {
                continue;
            }
        }

        ranked.push({ suggestion, match_rank });
    }

    ranked.sort((a, b) =>
        a.match_rank - b.match_rank
        || a.suggestion.rank - b.suggestion.rank
        || a.suggestion.label.localeCompare(b.suggestion.label, undefined, { numeric: true })
        || a.suggestion.detail.localeCompare(b.suggestion.detail, undefined, { numeric: true }));

    return ranked.slice(0, autocomplete_suggestion_limit).map(entry => entry.suggestion);
}

function ensureAutocompleteCaretMirror() {
    if (autocomplete_caret_mirror_elem) {
        return autocomplete_caret_mirror_elem;
    }

    autocomplete_caret_mirror_elem = document.createElement('div');
    autocomplete_caret_mirror_elem.style.position = 'absolute';
    autocomplete_caret_mirror_elem.style.visibility = 'hidden';
    autocomplete_caret_mirror_elem.style.left = '-10000px';
    autocomplete_caret_mirror_elem.style.top = '0';
    autocomplete_caret_mirror_elem.style.whiteSpace = 'pre-wrap';
    autocomplete_caret_mirror_elem.style.wordWrap = 'break-word';
    autocomplete_caret_mirror_elem.style.overflowWrap = 'break-word';
    document.body.appendChild(autocomplete_caret_mirror_elem);
    return autocomplete_caret_mirror_elem;
}

function getAutocompleteCaretCoordinates(position) {
    const mirror = ensureAutocompleteCaretMirror();
    const style = getComputedStyle(query_area);
    const mirrored_properties = [
        'boxSizing', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
        'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'textTransform', 'tabSize'
    ];

    for (const property of mirrored_properties) {
        mirror.style[property] = style[property];
    }

    mirror.style.width = `${query_area.offsetWidth}px`;
    mirror.textContent = query_area.value.substring(0, position);
    if (mirror.textContent.endsWith('\n')) {
        mirror.appendChild(document.createTextNode(' '));
    }

    const marker = document.createElement('span');
    marker.style.display = 'inline-block';
    marker.style.width = '0';
    marker.style.height = style.lineHeight;
    mirror.appendChild(marker);

    const mirror_rect = mirror.getBoundingClientRect();
    const marker_rect = marker.getBoundingClientRect();
    return {
        left: marker_rect.left - mirror_rect.left - query_area.scrollLeft,
        top: marker_rect.bottom - mirror_rect.top - query_area.scrollTop
    };
}

function positionAutocompleteMenu() {
    if (!autocomplete_state.open) {
        return;
    }

    const query_div_rect = query_area.parentElement.getBoundingClientRect();
    const query_rect = query_area.getBoundingClientRect();
    const caret = getAutocompleteCaretCoordinates(query_area.selectionStart ?? query_area.value.length);
    const menu_width = autocomplete_menu_elem.offsetWidth || 288;
    const menu_height = autocomplete_menu_elem.offsetHeight || 180;
    const query_div_width = query_area.parentElement.clientWidth || query_area.offsetWidth;

    let left = query_rect.left - query_div_rect.left + caret.left;
    let top = query_rect.top - query_div_rect.top + caret.top + 2;

    left = Math.max(4, Math.min(left, Math.max(4, query_div_width - menu_width - 4)));
    if (top + menu_height > query_area.offsetHeight && top > menu_height) {
        top = Math.max(4, top - menu_height - 20);
    }

    autocomplete_menu_elem.style.left = `${left}px`;
    autocomplete_menu_elem.style.top = `${top}px`;
}

function renderAutocompleteMenu() {
    autocomplete_menu_elem.innerHTML = '';
    autocomplete_menu_elem.classList.toggle('open', autocomplete_state.open);
    query_area.setAttribute('aria-expanded', autocomplete_state.open ? 'true' : 'false');

    if (!autocomplete_state.open) {
        query_area.removeAttribute('aria-activedescendant');
        return;
    }

    if (!autocomplete_state.items.length) {
        const empty = document.createElement('div');
        empty.className = 'autocomplete-empty';
        empty.innerText = autocomplete_state.loading ? 'Loading schema...' : 'No schema suggestions';
        autocomplete_menu_elem.appendChild(empty);
        query_area.removeAttribute('aria-activedescendant');
        positionAutocompleteMenu();
        return;
    }

    autocomplete_state.items.forEach((item, index) => {
        const row = document.createElement('div');
        row.id = `autocomplete-option-${index}`;
        row.className = 'autocomplete-item';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', index == autocomplete_state.active_index ? 'true' : 'false');
        if (index == autocomplete_state.active_index) {
            row.classList.add('is-active');
            query_area.setAttribute('aria-activedescendant', row.id);
        }

        const kind = document.createElement('div');
        kind.className = 'autocomplete-kind';
        kind.innerText = item.kind.replace('-', ' ');

        const main = document.createElement('div');
        main.className = 'autocomplete-main';

        const label = document.createElement('div');
        label.className = 'autocomplete-label monospace';
        label.innerText = item.label;

        const detail = document.createElement('div');
        detail.className = 'autocomplete-detail monospace';
        detail.innerText = item.detail;

        main.appendChild(label);
        if (item.detail) {
            main.appendChild(detail);
        }

        row.appendChild(kind);
        row.appendChild(main);
        row.addEventListener('mousemove', () => setAutocompleteActiveIndex(index));
        row.addEventListener('mousedown', e => {
            e.preventDefault();
            acceptAutocomplete(index);
        });
        autocomplete_menu_elem.appendChild(row);
    });

    positionAutocompleteMenu();
    const active = autocomplete_menu_elem.querySelector('.autocomplete-item.is-active');
    if (active) {
        active.scrollIntoView({ block: 'nearest' });
    }
}

function setAutocompleteActiveIndex(index) {
    if (!autocomplete_state.open || !autocomplete_state.items.length) {
        return;
    }

    const item_count = autocomplete_state.items.length;
    autocomplete_state.active_index = (index + item_count) % item_count;
    renderAutocompleteMenu();
}

function refreshAutocompleteFromEditor() {
    if (!autocomplete_state.open) {
        return;
    }

    if (query_area.selectionStart !== query_area.selectionEnd) {
        closeAutocomplete();
        return;
    }

    const context = getAutocompleteContext();
    if (context.cursor < autocomplete_state.replace_start) {
        closeAutocomplete();
        return;
    }

    const loading_tables = ensureAutocompleteTablesLoaded(context) || isAutocompleteLoadingTables(context);
    const loading_columns = ensureAutocompleteColumnsLoaded(context) || isAutocompleteLoadingColumns(context);
    const loading = loading_tables || loading_columns;
    if (context.scope_key != autocomplete_state.scope_key
        || context.statement_key != autocomplete_state.statement_key
        || context.replace_start != autocomplete_state.replace_start
        || autocomplete_state.schema_revision != autocomplete_schema_revision
        || autocomplete_state.loading != loading) {
        autocomplete_state.scope_key = context.scope_key;
        autocomplete_state.statement_key = context.statement_key;
        autocomplete_state.replace_start = context.replace_start;
        autocomplete_state.all_items = collectSchemaAutocompleteSuggestions(context);
        autocomplete_state.active_index = 0;
        autocomplete_state.schema_revision = autocomplete_schema_revision;
    }

    autocomplete_state.prefix = context.prefix;
    autocomplete_state.loading = loading;
    autocomplete_state.items = filterAutocompleteSuggestions(autocomplete_state.all_items, context.prefix);
    if (autocomplete_state.active_index >= autocomplete_state.items.length) {
        autocomplete_state.active_index = 0;
    }

    renderAutocompleteMenu();
}

function openSchemaAutocomplete(trigger) {
    if (query_area.selectionStart !== query_area.selectionEnd) {
        return;
    }

    const context = getAutocompleteContext();
    if (trigger == 'dot' && !context.scope_parts.length) {
        return;
    }

    const all_items = collectSchemaAutocompleteSuggestions(context);
    const loading_tables = ensureAutocompleteTablesLoaded(context) || isAutocompleteLoadingTables(context);
    const loading_columns = ensureAutocompleteColumnsLoaded(context) || isAutocompleteLoadingColumns(context);
    const loading = loading_tables || loading_columns;
    if (trigger == 'dot' && !all_items.length) {
        if (!loading) {
            closeAutocomplete();
            return;
        }
    }

    autocomplete_state = {
        open: true,
        replace_start: context.replace_start,
        scope_key: context.scope_key,
        statement_key: context.statement_key,
        items: filterAutocompleteSuggestions(all_items, context.prefix),
        all_items,
        active_index: 0,
        prefix: context.prefix,
        loading,
        schema_revision: autocomplete_schema_revision
    };
    renderAutocompleteMenu();
}

function closeAutocomplete() {
    if (!autocomplete_state.open) {
        return;
    }

    autocomplete_state.open = false;
    autocomplete_state.items = [];
    autocomplete_state.all_items = [];
    autocomplete_state.loading = false;
    renderAutocompleteMenu();
}

function acceptAutocomplete(index = autocomplete_state.active_index) {
    if (!autocomplete_state.open || !autocomplete_state.items.length) {
        return false;
    }

    const item = autocomplete_state.items[index] || autocomplete_state.items[0];
    const start = autocomplete_state.replace_start;
    const end = query_area.selectionStart ?? start;
    const next_cursor = start + item.insert_text.length;
    closeAutocomplete();
    replaceQueryEditorRange(item.insert_text, start, end, next_cursor, next_cursor);
    return true;
}

function handleQueryAutocompleteKeyDown(e) {
    if (autocomplete_state.open) {
        if (e.key == 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setAutocompleteActiveIndex(autocomplete_state.active_index + 1);
            return;
        }

        if (e.key == 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setAutocompleteActiveIndex(autocomplete_state.active_index - 1);
            return;
        }

        if (e.key == 'Enter' || (e.key == 'Tab' && !e.shiftKey)) {
            if (autocomplete_state.items.length && acceptAutocomplete()) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        if (e.key == 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeAutocomplete();
            return;
        }
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key == ' ' || e.code == 'Space')) {
        e.preventDefault();
        e.stopPropagation();
        openSchemaAutocomplete('manual');
        return;
    }

    if (e.key == '.' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setTimeout(() => openSchemaAutocomplete('dot'), 0);
    }
}
