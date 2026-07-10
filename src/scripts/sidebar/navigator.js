function getTableQueryLogQuery(database, table) {
    return `SELECT
    event_time,
    user,
    query_duration_ms,
    read_rows,
    read_bytes,
    result_rows,
    memory_usage,
    query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND (
      query ILIKE '%"${database}"."${table}"%'
      OR query ILIKE '%${database}.${table}%'
  )
ORDER BY event_time DESC
LIMIT 100`;
}

async function fetchTableColumns(server_address, user, password, database, table) {
    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?') +
        'add_http_cors_header=1&default_format=JSON';
    if (user) url += '&user=' + encodeURIComponent(user);
    if (password) url += '&password=' + encodeURIComponent(password);
    url += '&param_database=' + encodeURIComponent(database);
    url += '&param_table=' + encodeURIComponent(table);

    let response = await fetch(url, {
        method: "POST",
        body: `SELECT name, type
            FROM system.columns
            WHERE database = {database:String} AND table = {table:String}
            ORDER BY position`,
        headers: { 'Authorization': 'never' } });
    if (!response.ok) {
        return false;
    }

    const json = await response.json();
    return json.data || [];
}

function buildInsertStatement(database, table, columns) {
    if (!columns.length) {
        return `INSERT INTO ${database}.${table}\nVALUES\n(\n    \n);`;
    }

    const column_lines = columns.map((column, index) =>
        `    ${column.name}${index < columns.length - 1 ? ',' : ''}`);
    const value_lines = columns.map((column, index) =>
        `    /* ${column.name} */${index < columns.length - 1 ? ',' : ''}`);

    return `INSERT INTO ${database}.${table}\n(\n${column_lines.join('\n')}\n)\nVALUES\n(\n${value_lines.join('\n')}\n);`;
}

function hideNavigatorContextMenu() {
    navigator_context_menu_elem.classList.remove('open');
    navigator_context_menu_elem.innerHTML = '';
}

function showNavigatorContextMenu(items, x, y, options = {}) {
    navigator_context_menu_elem.innerHTML = '';

    for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.disabled = !!item.disabled;

        const icon = document.createElement('span');
        icon.className = 'navigator-menu-icon';
        icon.innerText = item.icon || '•';

        const label = document.createElement('span');
        label.className = 'navigator-menu-label';
        label.innerText = item.label;

        button.appendChild(icon);
        button.appendChild(label);
        button.addEventListener('click', e => {
            e.stopPropagation();
            hideNavigatorContextMenu();
            if (!item.disabled) {
                item.onClick();
            }
        });
        navigator_context_menu_elem.appendChild(button);
    }

    navigator_context_menu_elem.classList.add('open');
    navigator_context_menu_elem.style.left = `${x}px`;
    navigator_context_menu_elem.style.top = `${y}px`;

    const rect = navigator_context_menu_elem.getBoundingClientRect();
    const requested_left = options.align == 'right' ? x - rect.width : x;
    const requested_top = options.vertical_align == 'top' ? y - rect.height : y;
    const max_left = Math.max(8, window.innerWidth - rect.width - 8);
    const max_top = Math.max(8, window.innerHeight - rect.height - 8);
    const next_left = Math.max(8, Math.min(requested_left, max_left));
    const next_top = Math.max(8, Math.min(requested_top, max_top));
    navigator_context_menu_elem.style.left = `${next_left}px`;
    navigator_context_menu_elem.style.top = `${next_top}px`;
}

function deleteConnectionById(connection_id) {
    const store = getSavedConnectionStore();
    const connections = store.connections.filter(connection => !isDeletedStorageRecord(connection));
    if (connections.length <= 1) {
        return;
    }

    const connection = store.connections.find(candidate => !isDeletedStorageRecord(candidate) && candidate.id == connection_id);
    if (!connection) {
        return;
    }

    const now = getStorageTimestamp();
    connection.updated_at = now;
    connection.deleted_at = now;
    const saved_store = saveConnectionStore(store);
    if (!saved_store) {
        return;
    }

    const visible_connections = saved_store.connections.filter(candidate => !isDeletedStorageRecord(candidate));

    if (current_connection_id == connection_id) {
        closeConnectionEditor();
        applyConnection(visible_connections[0]);
    } else {
        renderNavigatorTree();
    }
}

function saveConnectionRecord(nextConnection) {
    const store = getSavedConnectionStore();
    const now = getStorageTimestamp();
    let updated = false;
    let deleted_elsewhere = false;

    const target_folder_id = nextConnection.folder_id
        && store.folders.some(folder => !isDeletedStorageRecord(folder) && folder.id == nextConnection.folder_id)
        ? nextConnection.folder_id
        : '';
    const normalized_connection = {
        ...nextConnection,
        id: String(nextConnection.id || createConnectionId()),
        name: String(nextConnection.name || `Connection ${getSavedConnections().length + 1}`),
        url: String(nextConnection.url || 'http://localhost:8123/'),
        user: String(nextConnection.user || 'default'),
        password: String(nextConnection.password || ''),
        folder_id: target_folder_id,
        updated_at: now,
        deleted_at: ''
    };

    store.connections = store.connections.map(connection => {
        if (connection.id == nextConnection.id) {
            if (isDeletedStorageRecord(connection)) {
                alert('That connection was deleted in another tab. Create a new connection instead.');
                updated = true;
                deleted_elsewhere = true;
                return connection;
            }
            updated = true;
            return normalized_connection;
        }
        return connection;
    });

    if (!updated) {
        store.connections.push(normalized_connection);
    }

    if (deleted_elsewhere) {
        renderNavigatorTree();
        return false;
    }

    const saved_store = saveConnectionStore(store);
    if (!saved_store) {
        return false;
    }

    const saved_connection = saved_store.connections.find(connection =>
        !isDeletedStorageRecord(connection) && connection.id == normalized_connection.id);
    if (!saved_connection) {
        alert('That connection was changed by another tab and was not saved.');
        renderNavigatorTree();
        return false;
    }

    applyConnection(saved_connection);
    return true;
}

function updateNavigatorFooter(connection = null) {
    if (!connection) {
        navigator_footer_primary_elem.innerText = 'No active connection';
        return;
    }

    navigator_footer_primary_elem.innerText = formatConnectionDisplayLabel(connection);
    navigator_footer_primary_elem.title = `${connection.name}\n${connection.user || 'default'} @ ${connection.url || ''}`;
}

function updateActiveConnectionBanner(connection = null) {
    if (!connection) {
        active_connection_name_elem.innerText = 'No active connection';
        active_connection_meta_elem.innerText = 'Select a connection in the navigator to run queries.';
        active_connection_banner_elem.title = '';
        return;
    }

    active_connection_name_elem.innerText = connection.name || 'Connection';
    active_connection_meta_elem.innerText = formatConnectionHeaderSummary(connection);
    active_connection_banner_elem.title = `${connection.name || 'Connection'}\n${connection.user || 'default'} @ ${connection.url || ''}`;
}

function openConnectionEditor(connection = null) {
    const draft = connection ? { ...connection } : createConnection(`Connection ${getSavedConnections().length + 1}`);
    connection_editor_state = { id: draft.id };
    connection_editor_title_elem.innerText = connection ? 'Edit connection' : 'New connection';
    connection_name_input_elem.value = draft.name || '';
    connection_url_input_elem.value = draft.url || 'http://localhost:8123/';
    connection_user_input_elem.value = draft.user || 'default';
    connection_password_input_elem.value = draft.password || '';
    renderConnectionFolderOptions(draft.folder_id || '');
    connection_editor_elem.classList.add('open');
    connection_name_input_elem.focus();
    connection_name_input_elem.select();
}

function closeConnectionEditor() {
    connection_editor_state = null;
    connection_editor_elem.classList.remove('open');
}

function saveConnectionEditor() {
    if (!connection_editor_state) {
        return;
    }

    const next_connection = {
        id: connection_editor_state.id,
        name: connection_name_input_elem.value.trim() || `Connection ${getSavedConnections().length + 1}`,
        url: connection_url_input_elem.value.trim() || 'http://localhost:8123/',
        user: connection_user_input_elem.value.trim() || 'default',
        password: connection_password_input_elem.value,
        folder_id: connection_folder_select_elem.value
    };

    if (saveConnectionRecord(next_connection)) {
        closeConnectionEditor();
    }
}

function openConnectionMenu(connection, anchor_rect) {
    const dashboard_url = getConnectionDashboardUrl(connection);
    const folders = getSavedConnectionFolders();
    const items = [
        {
            icon: '✎',
            label: 'Edit connection',
            onClick: () => openConnectionEditor(connection)
        },
        {
            icon: '↗',
            label: 'Open dashboard',
            disabled: !dashboard_url,
            onClick: () => openConnectionDashboard(connection)
        },
        {
            icon: '⇱',
            label: 'Move to top level',
            disabled: !(connection.folder_id || ''),
            onClick: () => moveConnectionToFolder(connection.id, '')
        },
        ...folders.map(folder => ({
            icon: '▤',
            label: `Move to ${folder.name}`,
            disabled: connection.folder_id == folder.id,
            onClick: () => moveConnectionToFolder(connection.id, folder.id)
        })),
        {
            icon: '✕',
            label: 'Delete connection',
            disabled: getSavedConnections().length <= 1,
            onClick: () => deleteConnectionById(connection.id)
        }
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function openDatabaseMenu(anchor_rect, database) {
    const items = [
        {
            icon: '↪',
            label: 'Insert database name',
            onClick: () => insertIntoQueryEditor(formatClickHouseIdentifier(database), { mode: 'insert' })
        }
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function openTableMenu(anchor_rect, server_address, user, password, database, table, engine) {
    const is_view = isViewEngine(engine);
    const is_materialized_view = isMaterializedViewEngine(engine);
    const is_dictionary = isDictionaryEngine(engine);
    const items = [
        {
            icon: '↪',
            label: 'Insert name',
            onClick: () => insertIntoQueryEditor(formatQualifiedIdentifier(database, table), { mode: 'insert' })
        },
        {
            icon: '≡',
            label: is_dictionary ? 'Generate SELECT from dictionary' : is_materialized_view ? 'Generate SELECT from materialized view' : is_view ? 'Generate SELECT from view' : 'Generate SELECT',
            onClick: () => insertTextIntoEditor(`SELECT * FROM ${database}.${table} LIMIT 100;`)
        },
        {
            icon: '☷',
            label: 'Generate SELECT with columns',
            onClick: async () => {
                const columns = await fetchTableColumns(server_address, user, password, database, table);
                if (columns === false) {
                    insertTextIntoEditor(`-- failed to load columns for ${database}.${table}\n`);
                    return;
                }
                insertTextIntoEditor(buildSelectStatement(database, table, columns));
            }
        },
        {
            icon: '∑',
            label: 'Generate SELECT count(*)',
            onClick: () => insertTextIntoEditor(`SELECT count(*) FROM ${database}.${table};`)
        },
        {
            icon: '#',
            label: 'Generate SELECT readable count',
            onClick: () => insertTextIntoEditor(buildReadableCountStatement(database, table))
        },
        {
            icon: '⌘',
            label: 'Generate SHOW TABLE',
            onClick: () => insertTextIntoEditor(`SHOW TABLE ${database}.${table};`)
        },
        {
            icon: '◫',
            label: 'Generate system.tables lookup',
            onClick: () => insertTextIntoEditor(`SELECT * FROM system.tables WHERE database = '${database}' AND table = '${table}';`)
        },
        {
            icon: '◷',
            label: 'Generate Query log lookup',
            onClick: () => insertTextIntoEditor(getTableQueryLogQuery(database, table))
        },
        ...(is_dictionary ? [] : [{
            icon: '✚',
            label: 'Generate INSERT',
            disabled: is_view,
            onClick: async () => {
                const columns = await fetchTableColumns(server_address, user, password, database, table);
                if (columns === false) {
                    insertTextIntoEditor(`-- failed to load columns for ${database}.${table}\n`);
                    return;
                }
                insertTextIntoEditor(buildInsertStatement(database, table, columns), { select_inserted: false });
            }
        }]),
        {
            icon: '✕',
            label: is_dictionary ? 'Generate DROP DICTIONARY' : is_materialized_view ? 'Generate DROP MATERIALIZED VIEW' : is_view ? 'Generate DROP VIEW' : 'Generate DROP TABLE',
            onClick: () => insertTextIntoEditor(buildDropStatement(database, table, engine))
        },
        ...(is_dictionary ? [{
            icon: '✕',
            label: 'Generate DROP DICTIONARY ON CLUSTER',
            onClick: () => insertTextIntoEditor(buildDropDictionaryOnClusterStatement(database, table))
        }] : [])
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function openColumnMenu(anchor_rect, database, table, column) {
    const items = [
        {
            icon: '∑',
            label: 'Generate Stats',
            disabled: !isNumericClickHouseType(column.type),
            onClick: () => insertTextIntoEditor(buildColumnStatsStatement(database, table, column.name))
        }
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function openSnippetFolderMenu(folder, anchor_rect) {
    const move_state = getSnippetFolderMoveState(folder.id);
    const items = [
        {
            icon: '▱',
            label: 'Save current query here',
            onClick: () => saveCurrentQueryAsSnippet(folder)
        },
        {
            icon: '↑',
            label: 'Move folder up',
            disabled: !move_state.can_move_up,
            onClick: () => moveSnippetFolder(folder.id, -1)
        },
        {
            icon: '↓',
            label: 'Move folder down',
            disabled: !move_state.can_move_down,
            onClick: () => moveSnippetFolder(folder.id, 1)
        },
        {
            icon: '✎',
            label: 'Rename folder',
            onClick: () => renameSnippetFolder(folder.id)
        },
        {
            icon: '✕',
            label: 'Delete folder',
            onClick: () => deleteSnippetFolder(folder.id)
        }
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function openSnippetMenu(snippet, anchor_rect) {
    const move_state = getSnippetMoveState(snippet.id);
    const items = [
        {
            icon: '+',
            label: 'Append to editor',
            onClick: () => insertSnippetIntoQueryEditor(snippet.query, 'append')
        },
        {
            icon: '↪',
            label: 'Insert at cursor',
            onClick: () => insertSnippetIntoQueryEditor(snippet.query, 'insert')
        },
        {
            icon: '▣',
            label: 'Replace editor',
            onClick: () => insertSnippetIntoQueryEditor(snippet.query, 'overwrite')
        },
        {
            icon: '▣',
            label: 'Update from editor',
            onClick: () => updateSnippetFromEditor(snippet.id)
        },
        {
            icon: '↑',
            label: 'Move snippet up',
            disabled: !move_state.can_move_up,
            onClick: () => moveSnippet(snippet.id, -1)
        },
        {
            icon: '↓',
            label: 'Move snippet down',
            disabled: !move_state.can_move_down,
            onClick: () => moveSnippet(snippet.id, 1)
        },
        {
            icon: '✎',
            label: 'Rename snippet',
            onClick: () => renameSnippet(snippet.id)
        },
        {
            icon: '✕',
            label: 'Delete snippet',
            onClick: () => deleteSnippet(snippet.id)
        }
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function toggleSnippetFolder(folder_id) {
    const folder = getSnippetFolder(folder_id);
    if (!folder) {
        return;
    }

    folder.expanded = !folder.expanded;
    folder.updated_at = getStorageTimestamp();
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function snippetMatchesFilter(snippet, filter) {
    if (!filter) {
        return true;
    }

    return `${snippet.name} ${snippet.query}`.toLowerCase().includes(filter);
}

function renderSnippets() {
    const filter = snippet_filter_elem.value.trim().toLowerCase();
    const visible_folders = getVisibleSnippetFolders();
    hideNavigatorContextMenu();
    snippets_browser_elem.innerHTML = '';

    if (!visible_folders.length) {
        snippets_browser_empty_elem.style.display = 'block';
        snippets_browser_empty_elem.innerText = filter ? 'No snippets matched the current filter.' : 'No saved snippets.';
        return;
    }

    for (const folder of visible_folders) {
        const folder_snippets = getSnippetFolderSnippets(folder.id);
        const folder_matches = filter && folder.name.toLowerCase().includes(filter);
        const visible_snippets = folder_matches
            ? folder_snippets
            : folder_snippets.filter(snippet => snippetMatchesFilter(snippet, filter));

        if (filter && !folder_matches && !visible_snippets.length) {
            continue;
        }

        const folder_elem = document.createElement('div');
        folder_elem.className = 'snippet-folder';
        const expanded = filter ? true : folder.expanded !== false;
        if (!expanded) {
            folder_elem.classList.add('collapsed');
        }

        const header = document.createElement('div');
        header.className = 'snippet-folder-header';
        header.addEventListener('contextmenu', e => {
            e.preventDefault();
            openSnippetFolderMenu(folder, { left: e.clientX, bottom: e.clientY });
        });

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'navigator-toggle';
        toggle.innerText = expanded ? '▾' : '▸';
        toggle.addEventListener('click', e => {
            e.stopPropagation();
            toggleSnippetFolder(folder.id);
        });

        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'snippet-folder-title';
        title.innerText = folder.name;
        title.title = folder.name;
        title.addEventListener('click', () => toggleSnippetFolder(folder.id));

        const actions = document.createElement('div');
        actions.className = 'snippet-folder-actions';

        const save_here_button = document.createElement('button');
        save_here_button.type = 'button';
        save_here_button.className = 'snippet-folder-action';
        save_here_button.title = 'Save current query here';
        save_here_button.setAttribute('aria-label', 'Save current query here');
        save_here_button.appendChild(createSnippetIcon('bookmark'));
        save_here_button.addEventListener('click', e => {
            e.stopPropagation();
            saveCurrentQueryAsSnippet(folder);
        });

        const menu_button = document.createElement('button');
        menu_button.type = 'button';
        menu_button.className = 'snippet-folder-action';
        menu_button.innerText = '⋮';
        menu_button.title = 'Folder actions';
        menu_button.addEventListener('click', e => {
            e.stopPropagation();
            openSnippetFolderMenu(folder, menu_button.getBoundingClientRect());
        });

        actions.appendChild(save_here_button);
        actions.appendChild(menu_button);

        header.appendChild(toggle);
        header.appendChild(title);
        header.appendChild(actions);
        folder_elem.appendChild(header);

        const children = document.createElement('div');
        children.className = 'snippet-folder-children';

        if (visible_snippets.length) {
            for (const snippet of visible_snippets) {
                const row = document.createElement('div');
                row.className = 'snippet-row';
                row.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    openSnippetMenu(snippet, { left: e.clientX, bottom: e.clientY });
                });

                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'snippet-button';
                button.title = snippet.query;
                button.addEventListener('click', () => insertSnippetIntoQueryEditor(snippet.query, getSnippetInsertionMode()));

                const name = document.createElement('span');
                name.className = 'snippet-name';
                name.innerText = snippet.name;

                const preview = document.createElement('span');
                preview.className = 'snippet-preview monospace';
                preview.innerText = formatSnippetPreview(snippet.query);

                button.appendChild(name);
                button.appendChild(preview);

                const row_actions = document.createElement('div');
                row_actions.className = 'snippet-row-actions';

                const row_menu = document.createElement('button');
                row_menu.type = 'button';
                row_menu.className = 'snippet-row-action';
                row_menu.innerText = '⋮';
                row_menu.title = 'Snippet actions';
                row_menu.addEventListener('click', e => {
                    e.stopPropagation();
                    openSnippetMenu(snippet, row_menu.getBoundingClientRect());
                });

                row_actions.appendChild(row_menu);
                row.appendChild(button);
                row.appendChild(row_actions);
                children.appendChild(row);
            }
        } else {
            children.appendChild(createNavigatorStatus(filter ? 'No snippets matched this folder.' : 'No snippets in this folder.'));
        }

        folder_elem.appendChild(children);
        snippets_browser_elem.appendChild(folder_elem);
    }

    snippets_browser_empty_elem.style.display = snippets_browser_elem.firstChild ? 'none' : 'block';
    if (!snippets_browser_elem.firstChild) {
        snippets_browser_empty_elem.innerText = 'No snippets matched the current filter.';
    }
}

function openConnectionFolderMenu(folder, anchor_rect) {
    const items = [
        {
            icon: '✎',
            label: 'Rename folder',
            onClick: () => renameConnectionFolder(folder.id)
        },
        {
            icon: '✕',
            label: 'Delete empty folder',
            disabled: getConnectionFolderConnections(folder.id).length > 0,
            onClick: () => deleteConnectionFolder(folder.id)
        }
    ];

    showNavigatorContextMenu(items, anchor_rect.left, anchor_rect.bottom + 4);
}

function updateNavigatorActions() {
    const has_selection = !!current_connection_id;
    refresh_schema_elem.disabled = !has_selection;
}

function setSidebarCollapsed(collapsed, persist = true) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);

    if (persist) {
        window.localStorage.setItem(sidebar_collapsed_key, collapsed ? '1' : '0');
    }
}

function resetSchemaBrowser(message) {
    ++autocomplete_schema_revision;
    autocomplete_table_loads = {};
    autocomplete_column_loads = {};
    schema_state = {
        loading: false,
        connection_id: null,
        databases: [],
        tables: {},
        columns: {},
        loading_tables: {},
        table_messages: {},
        message: message || 'No schema loaded.'
    };
    renderNavigatorTree();
}

function createNavigatorStatus(message) {
    const status = document.createElement('div');
    status.className = 'no-tables';
    status.innerText = message;
    return status;
}

function createNavigatorStatusAction(message, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'navigator-status-action';
    button.innerText = message;
    button.addEventListener('click', e => {
        e.stopPropagation();
        action();
    });
    return button;
}

function createConnectionNavigatorNode(connection, filter) {
    const connection_matches = `${connection.name} ${connection.user} ${connection.url}`.toLowerCase().includes(filter);
    const has_matching_database = connection.id == current_connection_id
        && schema_state.databases.some(database_info => matchesSchemaFilter(database_info.database, filter));

    if (filter && !connection_matches && !has_matching_database) {
        return null;
    }

    const connection_node = document.createElement('div');
    connection_node.className = 'navigator-connection';
    if (connection.id == current_connection_id) {
        connection_node.classList.add('current');
    }

    const header = document.createElement('div');
    header.className = 'navigator-connection-header';
    header.title = `${connection.name}\n${connection.user || 'default'} @ ${connection.url || ''}`;
    header.addEventListener('contextmenu', e => {
        e.preventDefault();
        openConnectionMenu(connection, { left: e.clientX, bottom: e.clientY });
    });

    const expanded = filter && has_matching_database
        ? true
        : isConnectionExpanded(connection.id);
    if (!expanded) {
        connection_node.classList.add('collapsed');
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'navigator-toggle';
    toggle.innerText = expanded ? '▾' : '▸';
    toggle.addEventListener('click', e => {
        e.stopPropagation();
        setConnectionExpanded(connection.id, !expanded);
        renderNavigatorTree();
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'navigator-connection-button';
    button.appendChild(createNavigatorLabel('◎', connection.name, 'connection'));
    const header_summary = formatConnectionHeaderSummary(connection);
    if (header_summary) {
        const summary = document.createElement('span');
        summary.className = 'navigator-connection-summary monospace';
        summary.innerText = header_summary;
        summary.title = `${connection.user || 'default'} @ ${connection.url || ''}`;
        button.appendChild(summary);
    }
    button.addEventListener('click', () => {
        setConnectionExpanded(connection.id, true);
        applyConnection(connection);
    });

    let current_badge = null;
    if (connection.id == current_connection_id) {
        current_badge = document.createElement('span');
        current_badge.className = 'navigator-connection-status';
        current_badge.innerText = 'Active';
    }

    const actions = document.createElement('div');
    actions.className = 'navigator-connection-actions';
    const can_toggle_all_databases = connection.id == schema_state.connection_id && !!schema_state.databases.length;

    const expand_all_button = document.createElement('button');
    expand_all_button.type = 'button';
    expand_all_button.className = 'navigator-connection-action';
    expand_all_button.innerText = '+';
    expand_all_button.title = can_toggle_all_databases ? 'Expand all databases' : 'Select this connection to load schema first';
    expand_all_button.disabled = !can_toggle_all_databases;
    expand_all_button.addEventListener('click', e => {
        e.stopPropagation();
        setAllConnectionDatabasesExpanded(connection, true);
    });

    const collapse_all_button = document.createElement('button');
    collapse_all_button.type = 'button';
    collapse_all_button.className = 'navigator-connection-action';
    collapse_all_button.innerText = '−';
    collapse_all_button.title = can_toggle_all_databases ? 'Collapse all databases' : 'Select this connection to load schema first';
    collapse_all_button.disabled = !can_toggle_all_databases;
    collapse_all_button.addEventListener('click', e => {
        e.stopPropagation();
        setAllConnectionDatabasesExpanded(connection, false);
    });

    const menu_button = document.createElement('button');
    menu_button.type = 'button';
    menu_button.className = 'navigator-connection-menu';
    menu_button.innerText = '⋮';
    menu_button.title = 'Connection actions';
    menu_button.addEventListener('click', e => {
        e.stopPropagation();
        const rect = menu_button.getBoundingClientRect();
        if (connection.id != current_connection_id) {
            applyConnection(connection);
        }
        openConnectionMenu(connection, rect);
    });

    actions.appendChild(expand_all_button);
    actions.appendChild(collapse_all_button);
    header.appendChild(toggle);
    header.appendChild(button);
    if (current_badge) {
        header.appendChild(current_badge);
    }
    header.appendChild(actions);
    header.appendChild(menu_button);
    connection_node.appendChild(header);

    const children = document.createElement('div');
    children.className = 'navigator-connection-children';

    if (expanded && connection.id == current_connection_id) {
        if (schema_state.loading && schema_state.connection_id == connection.id) {
            children.appendChild(createNavigatorStatus('Loading schema...'));
        } else if (schema_state.connection_id == connection.id && schema_state.databases.length) {
            const visible_databases = schema_state.databases.filter(database_info =>
                matchesSchemaFilter(database_info.database, filter));

            for (const database_info of visible_databases) {
                let database = document.createElement('div');
                database.className = 'database';
                const database_expanded = filter
                    ? true
                    : isDatabaseExpanded(connection.id, database_info.database);
                if (!database_expanded) {
                    database.classList.add('collapsed');
                }

                let database_header = document.createElement('div');
                database_header.className = 'database-header';
                database_header.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    openDatabaseMenu({ left: e.clientX, bottom: e.clientY }, database_info.database);
                });

                let database_toggle = document.createElement('button');
                database_toggle.type = 'button';
                database_toggle.className = 'navigator-toggle';
                database_toggle.innerText = database_expanded ? '▾' : '▸';

                let database_link = document.createElement('button');
                database_link.type = 'button';
                database_link.className = 'database-button';
                database_link.title = 'Click to expand. Right-click for actions';
                if (database_info.current) database_link.classList.add('current');
                database_link.appendChild(createNavigatorLabel('🛢️', database_info.database, 'database'));

                const database_actions = document.createElement('div');
                database_actions.className = 'navigator-header-actions';

                const expand_database_button = document.createElement('button');
                expand_database_button.type = 'button';
                expand_database_button.className = 'navigator-header-action';
                expand_database_button.innerText = '+';
                expand_database_button.title = 'Expand all tables and views in this database';

                const collapse_database_button = document.createElement('button');
                collapse_database_button.type = 'button';
                collapse_database_button.className = 'navigator-header-action';
                collapse_database_button.innerText = '−';
                collapse_database_button.title = 'Collapse all tables and views in this database';

                const toggle_database_tables = async expanded => {
                    let database_rows = schema_state.tables[database_info.database];
                    if (!database_rows && !schema_state.loading_tables[database_info.database]) {
                        database_rows = await loadTables(connection.url, connection.user, connection.password, database_info.database);
                    }
                    if (!database_rows || database_rows === false) {
                        return;
                    }

                    setTablesExpanded(connection.id, database_info.database, database_rows.map(row => row.table), expanded);
                    renderNavigatorTree();
                };

                expand_database_button.addEventListener('click', async e => {
                    e.stopPropagation();
                    await toggle_database_tables(true);
                });
                collapse_database_button.addEventListener('click', async e => {
                    e.stopPropagation();
                    await toggle_database_tables(false);
                });

                database_actions.appendChild(expand_database_button);
                database_actions.appendChild(collapse_database_button);

                let tables = document.createElement('div');
                tables.className = 'tables';

                database_header.appendChild(database_toggle);
                database_header.appendChild(database_link);
                database_header.appendChild(database_actions);
                database.appendChild(database_header);
                database.appendChild(tables);
                children.appendChild(database);

                const toggle_database = () => {
                    const next_expanded = !isDatabaseExpanded(connection.id, database_info.database);
                    setDatabaseExpanded(connection.id, database_info.database, next_expanded);
                    renderNavigatorTree();
                    if (next_expanded
                        && !schema_state.tables[database_info.database]
                        && !schema_state.loading_tables[database_info.database]) {
                        loadTables(connection.url, connection.user, connection.password, database_info.database);
                    }
                };

                database_toggle.addEventListener('click', e => {
                    e.stopPropagation();
                    toggle_database();
                });
                database_link.addEventListener('click', e => {
                    e.stopPropagation();
                    toggle_database();
                });

                if (database_expanded) {
                    if (schema_state.loading_tables[database_info.database]) {
                        tables.appendChild(createNavigatorStatus('Loading tables...'));
                    } else if (schema_state.table_messages[database_info.database]) {
                        tables.appendChild(createNavigatorStatus(schema_state.table_messages[database_info.database]));
                    } else if (schema_state.tables[database_info.database]) {
                        renderTableGroups(connection.id, connection.url, connection.user, connection.password, database_info.database, tables, schema_state.tables[database_info.database]);
                    } else {
                        tables.appendChild(createNavigatorStatus('Loading tables...'));
                        loadTables(connection.url, connection.user, connection.password, database_info.database);
                    }
                }
            }
            if (!visible_databases.length) {
                children.appendChild(createNavigatorStatus('No databases matched the current filter.'));
            }
        } else if (schema_state.message) {
            children.appendChild(createNavigatorStatus(schema_state.message));
        }
    } else if (expanded) {
        children.appendChild(createNavigatorStatusAction('click to load schema', () => {
            setConnectionExpanded(connection.id, true);
            applyConnection(connection);
        }));
    }

    connection_node.appendChild(children);
    return connection_node;
}

function createConnectionFolderNavigatorNode(folder, connections, filter) {
    const folder_connections = connections.filter(connection => connection.folder_id == folder.id);
    const folder_matches = filter && folder.name.toLowerCase().includes(filter);
    const visible_connection_nodes = [];

    for (const connection of folder_connections) {
        const node = createConnectionNavigatorNode(connection, folder_matches ? '' : filter);
        if (node) {
            visible_connection_nodes.push(node);
        }
    }

    if (filter && !folder_matches && !visible_connection_nodes.length) {
        return null;
    }

    const folder_node = document.createElement('div');
    folder_node.className = 'navigator-folder';
    const expanded = filter ? true : folder.expanded !== false;
    if (!expanded) {
        folder_node.classList.add('collapsed');
    }

    const header = document.createElement('div');
    header.className = 'navigator-folder-header';
    header.addEventListener('contextmenu', e => {
        e.preventDefault();
        openConnectionFolderMenu(folder, { left: e.clientX, bottom: e.clientY });
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'navigator-toggle';
    toggle.innerText = expanded ? '▾' : '▸';
    toggle.addEventListener('click', e => {
        e.stopPropagation();
        setConnectionFolderExpanded(folder.id, !expanded);
        renderNavigatorTree();
    });

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'navigator-folder-title';
    title.innerText = folder.name;
    title.title = folder.name;
    title.addEventListener('click', () => {
        setConnectionFolderExpanded(folder.id, !expanded);
        renderNavigatorTree();
    });

    const actions = document.createElement('div');
    actions.className = 'navigator-folder-actions';

    const menu_button = document.createElement('button');
    menu_button.type = 'button';
    menu_button.className = 'navigator-folder-action';
    menu_button.innerText = '⋮';
    menu_button.title = 'Folder actions';
    menu_button.addEventListener('click', e => {
        e.stopPropagation();
        openConnectionFolderMenu(folder, menu_button.getBoundingClientRect());
    });
    actions.appendChild(menu_button);

    header.appendChild(toggle);
    header.appendChild(title);
    header.appendChild(actions);
    folder_node.appendChild(header);

    const children = document.createElement('div');
    children.className = 'navigator-folder-children';
    if (visible_connection_nodes.length) {
        for (const node of visible_connection_nodes) {
            children.appendChild(node);
        }
    } else {
        children.appendChild(createNavigatorStatus('No connections in this folder.'));
    }
    folder_node.appendChild(children);
    return folder_node;
}

function renderNavigatorTree() {
    const store = getSavedConnectionStore();
    const connections = store.connections.filter(connection => !isDeletedStorageRecord(connection));
    const folders = store.folders.filter(folder => !isDeletedStorageRecord(folder));
    const filter = schema_filter_elem.value.trim().toLowerCase();
    hideNavigatorContextMenu();
    schema_browser_elem.innerHTML = '';
    updateNavigatorActions();

    if (!connections.length && !folders.length) {
        schema_browser_empty_elem.style.display = 'block';
        schema_browser_empty_elem.innerText = 'No saved connections.';
        return;
    }

    for (const connection of connections.filter(connection => !(connection.folder_id || ''))) {
        const node = createConnectionNavigatorNode(connection, filter);
        if (node) {
            schema_browser_elem.appendChild(node);
        }
    }

    for (const folder of folders) {
        const node = createConnectionFolderNavigatorNode(folder, connections, filter);
        if (node) {
            schema_browser_elem.appendChild(node);
        }
    }

    schema_browser_empty_elem.style.display = schema_browser_elem.firstChild ? 'none' : 'block';
    if (!schema_browser_elem.firstChild) {
        schema_browser_empty_elem.innerText = 'No navigator items matched the current filter.';
    }
}

function renderTableGroups(connection_id, server_address, user, password, database, tables_elem, table_rows) {
    while (tables_elem.firstChild) tables_elem.removeChild(tables_elem.firstChild);

    const filter = schema_filter_elem.value.trim().toLowerCase();

    const sorted_rows = [...table_rows].sort((a, b) => a.table.localeCompare(b.table, undefined, { numeric: true }));
    const groups = [
        { name: 'Tables', kind: 'table', rows: sorted_rows.filter(elem => getSchemaItemKind(elem.engine) == 'table') },
        { name: 'Dictionaries', kind: 'dictionary', rows: sorted_rows.filter(elem => getSchemaItemKind(elem.engine) == 'dictionary') },
        { name: 'Materialized Views', kind: 'materialized-view', rows: sorted_rows.filter(elem => getSchemaItemKind(elem.engine) == 'materialized-view') },
        { name: 'Views', kind: 'view', rows: sorted_rows.filter(elem => getSchemaItemKind(elem.engine) == 'view') }
    ];

    for (const group of groups) {
        const filtered_tables = group.rows.filter(elem => !filter || `${database}.${elem.table}`.toLowerCase().includes(filter));
        if (!filtered_tables.length) {
            continue;
        }

        let group_elem = document.createElement('div');
        group_elem.className = 'schema-group';

        const group_expanded = filter ? true : isSchemaGroupExpanded(connection_id, database, group.name);
        if (!group_expanded) {
            group_elem.classList.add('collapsed');
        }

        let group_title = document.createElement('div');
        group_title.className = 'schema-group-title';
        const group_toggle = document.createElement('span');
        group_toggle.className = 'schema-group-toggle';
        group_toggle.innerText = group_expanded ? '▾' : '▸';

        const group_label = createNavigatorLabel(getSchemaItemIcon(group.kind), group.name, group.kind);
        const group_count = document.createElement('span');
        group_count.className = 'schema-group-count';
        group_count.innerText = String(filtered_tables.length);

        group_title.appendChild(group_toggle);
        group_title.appendChild(group_label);
        group_title.addEventListener('click', () => {
            setSchemaGroupExpanded(connection_id, database, group.name, !group_expanded);
            renderNavigatorTree();
        });
        group_title.appendChild(group_count);
        group_elem.appendChild(group_title);

        const group_items = document.createElement('div');
        group_items.className = 'schema-group-items';

        for (let elem of filtered_tables) {
            let table = document.createElement('div');
            table.className = 'table';
            const item_kind = getSchemaItemKind(elem.engine);

            let table_row = document.createElement('div');
            table_row.className = 'table-row';
            table_row.addEventListener('contextmenu', e => {
                e.preventDefault();
                openTableMenu({ left: e.clientX, bottom: e.clientY }, server_address, user, password, database, elem.table, elem.engine);
            });

            let toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'table-toggle';
            const table_expanded = isTableExpanded(connection_id, database, elem.table);
            toggle.innerText = table_expanded ? '▾' : '▸';

            let table_main = document.createElement('div');
            table_main.className = 'table-main';

            let table_link = document.createElement('button');
            table_link.type = 'button';
            table_link.className = 'table-link';
            table_link.appendChild(createNavigatorLabel('', elem.table, item_kind));

            let table_meta = document.createElement('span');
            table_meta.className = 'table-meta monospace';
            table_meta.title = `${elem.engine}${+elem.total_rows ? ` • ${formatReadableRows(elem.total_rows)} rows` : ''}${+elem.total_bytes ? ` • ${formatReadableBytes(elem.total_bytes)}` : ''}`;
            table_meta.textContent = elem.engine;

            let table_menu_button = document.createElement('button');
            table_menu_button.type = 'button';
            table_menu_button.className = 'table-menu';
            table_menu_button.innerText = '⋯';
            table_menu_button.title = item_kind == 'dictionary' ? 'Dictionary actions' : 'Table actions';
            table_menu_button.addEventListener('click', e => {
                e.stopPropagation();
                const rect = table_menu_button.getBoundingClientRect();
                openTableMenu(rect, server_address, user, password, database, elem.table, elem.engine);
            });

            const columns = document.createElement('div');
            columns.className = table_expanded ? 'columns open' : 'columns';

            const toggle_columns = async e => {
                e?.stopPropagation();
                const will_open = !columns.classList.contains('open');
                setTablesExpanded(connection_id, database, [elem.table], will_open);
                columns.classList.toggle('open', will_open);
                toggle.innerText = will_open ? '▾' : '▸';
                if (will_open) {
                    await loadColumns(server_address, user, password, database, elem.table, columns);
                }
            };

            toggle.addEventListener('click', toggle_columns);

            table_main.appendChild(table_link);
            table_main.appendChild(table_meta);
            table_main.appendChild(table_menu_button);
            table_row.appendChild(toggle);
            table_row.appendChild(table_main);
            table.appendChild(table_row);
            table.appendChild(columns);
            table_link.addEventListener('click', toggle_columns);
            if (table_expanded) {
                void loadColumns(server_address, user, password, database, elem.table, columns);
            }
            group_items.appendChild(table);
        }

        group_elem.appendChild(group_items);
        tables_elem.appendChild(group_elem);
    }

    if (!tables_elem.firstChild) {
        let table = document.createElement('div');
        table.className = 'no-tables';
        table.append('no tables');
        tables_elem.append(table);
    }
}

function applyConnection(connection) {
    if (!connection) {
        return;
    }

    closeConnectionEditor();
    current_connection_id = connection.id;
    current_connection_name = connection.name || 'Connection';
    window.localStorage.setItem(active_connection_key, current_connection_id);
    setConnectionExpanded(current_connection_id, true);
    updateNavigatorFooter(connection);
    updateActiveConnectionBanner(connection);

    url_elem.value = connection.url || '';
    user_elem.value = connection.user || 'default';
    password_elem.value = connection.password || '';

    renderNavigatorTree();
    checkURL();
    loadDatabases(connection.url, connection.user, connection.password);
}

function saveCurrentConnection(newConnection) {
    const connections = getSavedConnections();
    const current_connection = connections.find(connection => connection.id == current_connection_id) || {};
    const nextConnection = newConnection || {
        id: current_connection_id || createConnectionId(),
        name: current_connection_name || `Connection ${connections.length + 1}`,
        url: url_elem.value.trim(),
        user: user_elem.value.trim() || 'default',
        password: password_elem.value,
        folder_id: current_connection.folder_id || ''
    };

    return saveConnectionRecord(nextConnection);
}

function loadConnections() {
    let connections = getSavedConnections();
    if (!connections.length) {
        const defaultConnection = createConnection('Localhost');
        connections = [defaultConnection];
        const saved_store = saveConnections(connections);
        if (saved_store) {
            connections = saved_store.connections.filter(connection => !isDeletedStorageRecord(connection));
        }
    }

    const storedActiveConnectionId = window.localStorage.getItem(active_connection_key);
    const activeConnection = connections.find(connection => connection.id == storedActiveConnectionId) || connections[0];
    applyConnection(activeConnection);
}

function handleSavedConnectionsChanged() {
    const connections = getSavedConnections();
    renderConnectionFolderOptions(connection_folder_select_elem.value);

    if (!connections.length) {
        closeConnectionEditor();
        current_connection_id = null;
        current_connection_name = 'default';
        updateNavigatorFooter();
        updateActiveConnectionBanner();
        resetSchemaBrowser('No schema loaded.');
        return;
    }

    const active_connection = connections.find(connection => connection.id == current_connection_id);
    if (!active_connection) {
        applyConnection(connections[0]);
        return;
    }

    current_connection_name = active_connection.name || 'Connection';
    updateNavigatorFooter(active_connection);
    updateActiveConnectionBanner(active_connection);
    renderNavigatorTree();
}

function handleQuerySnippetsChanged() {
    query_snippets_state = loadQuerySnippets();
    renderSnippets();
}
