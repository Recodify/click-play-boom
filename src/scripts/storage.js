function createConnectionId() {
    return `connection-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createConnectionFolderId() {
    return `connection-folder-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createConnection(name) {
    const now = getStorageTimestamp();
    return {
        id: createConnectionId(),
        name: name || `Connection ${getSavedConnections().length + 1}`,
        url: url_elem.value || 'http://localhost:8123/',
        user: user_elem.value || 'default',
        password: password_elem.value || '',
        folder_id: '',
        schema_compat_database: 'system',
        updated_at: now,
        deleted_at: ''
    };
}

function getStorageTimestamp() {
    return new Date().toISOString();
}

function isDeletedStorageRecord(record) {
    return !!record?.deleted_at;
}

function getStorageRecordRevision(record) {
    return String(record?.deleted_at || record?.updated_at || '');
}

function mergeStorageRecords(persisted_records, local_records) {
    const merged = new Map();

    for (const record of persisted_records || []) {
        if (record?.id) {
            merged.set(record.id, { ...record });
        }
    }

    for (const record of local_records || []) {
        if (!record?.id) {
            continue;
        }

        const existing = merged.get(record.id);
        if (!existing) {
            merged.set(record.id, { ...record });
            continue;
        }

        if (existing.deleted_at && !record.deleted_at) {
            continue;
        }

        if (record.deleted_at && !existing.deleted_at) {
            merged.set(record.id, { ...record });
            continue;
        }

        if (getStorageRecordRevision(record) >= getStorageRecordRevision(existing)) {
            merged.set(record.id, { ...record });
        }
    }

    return [...merged.values()];
}

function createVersionedStorageEnvelope(data) {
    return {
        schema_version: storage_schema_version,
        updated_at: getStorageTimestamp(),
        ...data
    };
}

function readVersionedStorage(key, empty_store) {
    try {
        const raw_value = window.localStorage.getItem(key);
        if (!raw_value) {
            return { store: empty_store(), unsupported_schema: false };
        }

        const parsed = JSON.parse(raw_value);
        const schema_version = Number(parsed?.schema_version || storage_schema_version);
        if (schema_version > storage_schema_version) {
            return {
                store: empty_store(),
                unsupported_schema: true,
                schema_version
            };
        }

        return { store: parsed, unsupported_schema: false };
    } catch (e) {
        return { store: empty_store(), unsupported_schema: false };
    }
}

function alertUnsupportedStorageSchema(store_name, schema_version) {
    alert(`${store_name} were saved by a newer Click Play Boom storage schema (${schema_version}). This version will not overwrite that data.`);
}

function normalizeConnectionStore(stored) {
    const store_updated_at = String(stored?.updated_at || '');
    const raw_folders = stored && !Array.isArray(stored) && Array.isArray(stored.folders)
        ? stored.folders
        : [];
    const folders = [];
    const active_folder_ids = new Set();

    for (const folder of raw_folders) {
        if (!folder || !folder.id || !folder.name || folders.some(candidate => candidate.id == String(folder.id))) {
            continue;
        }

        const normalized_folder = {
            id: String(folder.id),
            name: String(folder.name),
            expanded: folder.expanded !== false,
            updated_at: String(folder.updated_at || folder.deleted_at || store_updated_at),
            deleted_at: String(folder.deleted_at || '')
        };
        folders.push(normalized_folder);
        if (!isDeletedStorageRecord(normalized_folder)) {
            active_folder_ids.add(normalized_folder.id);
        }
    }

    const raw_connections = Array.isArray(stored)
        ? stored
        : stored && Array.isArray(stored.connections) ? stored.connections : [];
    const connections = [];
    const connection_ids = new Set();

    for (const connection of raw_connections) {
        if (!connection || !connection.id || connection_ids.has(String(connection.id))) {
            continue;
        }

        const folder_id = String(connection.folder_id || '');
        const normalized_connection = {
            ...connection,
            id: String(connection.id),
            name: String(connection.name || 'Connection'),
            url: String(connection.url || 'http://localhost:8123/'),
            user: String(connection.user || 'default'),
            password: String(connection.password || ''),
            folder_id: active_folder_ids.has(folder_id) || isDeletedStorageRecord(connection) ? folder_id : '',
            schema_compat_database: String(connection.schema_compat_database || 'system'),
            updated_at: String(connection.updated_at || connection.deleted_at || store_updated_at),
            deleted_at: String(connection.deleted_at || '')
        };
        connections.push(normalized_connection);
        connection_ids.add(normalized_connection.id);
    }

    return createVersionedStorageEnvelope({ folders: folders, connections: connections });
}

function emptyConnectionStore() {
    return createVersionedStorageEnvelope({ folders: [], connections: [] });
}

function getSavedConnectionStore() {
    const result = readVersionedStorage(saved_connections_key, emptyConnectionStore);
    return normalizeConnectionStore(result.store);
}

function getPersistedConnectionStoreForSave() {
    const result = readVersionedStorage(saved_connections_key, emptyConnectionStore);
    if (result.unsupported_schema) {
        alertUnsupportedStorageSchema('Saved connections', result.schema_version);
        return null;
    }

    return normalizeConnectionStore(result.store);
}

function saveConnectionStore(store) {
    const latest_store = getPersistedConnectionStoreForSave();
    if (!latest_store) {
        return null;
    }

    const normalized_store = normalizeConnectionStore(store);
    const merged_store = createVersionedStorageEnvelope({
        folders: mergeStorageRecords(latest_store.folders, normalized_store.folders),
        connections: mergeStorageRecords(latest_store.connections, normalized_store.connections)
    });

    window.localStorage.setItem(saved_connections_key, JSON.stringify(merged_store));
    return normalizeConnectionStore(merged_store);
}

function getSavedConnections() {
    return getSavedConnectionStore().connections.filter(connection => !isDeletedStorageRecord(connection));
}

function getSavedConnectionFolders() {
    return getSavedConnectionStore().folders.filter(folder => !isDeletedStorageRecord(folder));
}

function saveConnectionSchemaCompatDatabase(connection_id, database) {
    const store = getSavedConnectionStore();
    const connection = store.connections.find(candidate =>
        !isDeletedStorageRecord(candidate) && candidate.id == connection_id);
    if (!connection) return null;

    connection.schema_compat_database = String(database || 'system');
    connection.updated_at = getStorageTimestamp();
    const saved_store = saveConnectionStore(store);
    return saved_store?.connections.find(candidate =>
        !isDeletedStorageRecord(candidate) && candidate.id == connection_id) || null;
}

function saveConnections(connections) {
    const store = getSavedConnectionStore();
    const now = getStorageTimestamp();
    const connection_ids = new Set((connections || []).map(connection => String(connection?.id || '')));
    store.connections = [
        ...store.connections.filter(connection => isDeletedStorageRecord(connection) || !connection_ids.has(connection.id)),
        ...(connections || []).filter(connection => connection?.id).map(connection => ({
            ...connection,
            updated_at: String(connection.updated_at || now),
            deleted_at: String(connection.deleted_at || '')
        }))
    ];

    return saveConnectionStore(store);
}

function findConnectionFolderByName(name) {
    const normalized_name = name.trim().toLowerCase();
    return getSavedConnectionFolders().find(folder => folder.name.toLowerCase() == normalized_name) || null;
}

function getConnectionFolder(folder_id) {
    return getSavedConnectionFolders().find(folder => folder.id == folder_id) || null;
}

function getConnectionFolderConnections(folder_id) {
    return getSavedConnections().filter(connection => (connection.folder_id || '') == folder_id);
}

function createConnectionFolder(name, expanded = true) {
    const now = getStorageTimestamp();
    const store = getSavedConnectionStore();
    const folder = {
        id: createConnectionFolderId(),
        name: name.trim(),
        expanded: expanded,
        updated_at: now,
        deleted_at: ''
    };
    store.folders.push(folder);
    if (!saveConnectionStore(store)) {
        return null;
    }
    return folder;
}

function setConnectionFolderExpanded(folder_id, expanded) {
    const store = getSavedConnectionStore();
    const now = getStorageTimestamp();
    for (const folder of store.folders) {
        if (!isDeletedStorageRecord(folder) && folder.id == folder_id) {
            folder.expanded = !!expanded;
            folder.updated_at = now;
            break;
        }
    }
    saveConnectionStore(store);
}

function createConnectionFolderFromPrompt() {
    const folder_name = prompt('Folder name', 'New folder');
    if (folder_name === null) {
        return;
    }

    const trimmed_name = folder_name.trim();
    if (!trimmed_name) {
        alert('Folder name is required.');
        return;
    }

    if (findConnectionFolderByName(trimmed_name)) {
        alert('A folder with that name already exists.');
        return;
    }

    if (!createConnectionFolder(trimmed_name)) {
        return;
    }
    renderConnectionFolderOptions(connection_folder_select_elem.value);
    renderNavigatorTree();
}

function renameConnectionFolder(folder_id) {
    const store = getSavedConnectionStore();
    const folder = store.folders.find(candidate => !isDeletedStorageRecord(candidate) && candidate.id == folder_id);
    if (!folder) {
        return;
    }

    const folder_name = prompt('Folder name', folder.name);
    if (folder_name === null) {
        return;
    }

    const trimmed_name = folder_name.trim();
    if (!trimmed_name) {
        alert('Folder name is required.');
        return;
    }

    const existing_folder = findConnectionFolderByName(trimmed_name);
    if (existing_folder && existing_folder.id != folder.id) {
        alert('A folder with that name already exists.');
        return;
    }

    folder.name = trimmed_name;
    folder.updated_at = getStorageTimestamp();
    if (!saveConnectionStore(store)) {
        return;
    }
    renderConnectionFolderOptions(connection_folder_select_elem.value);
    renderNavigatorTree();
}

function deleteConnectionFolder(folder_id) {
    const store = getSavedConnectionStore();
    const folder = store.folders.find(candidate => !isDeletedStorageRecord(candidate) && candidate.id == folder_id);
    if (!folder) {
        return;
    }

    if (store.connections.some(connection => !isDeletedStorageRecord(connection) && connection.folder_id == folder.id)) {
        alert('Move or delete the connections in this folder first.');
        return;
    }

    if (!confirm(`Delete empty folder "${folder.name}"?`)) {
        return;
    }

    const now = getStorageTimestamp();
    folder.updated_at = now;
    folder.deleted_at = now;
    if (!saveConnectionStore(store)) {
        return;
    }
    renderConnectionFolderOptions(connection_folder_select_elem.value);
    renderNavigatorTree();
}

function moveConnectionToFolder(connection_id, folder_id) {
    const store = getSavedConnectionStore();
    const now = getStorageTimestamp();
    const target_folder_id = folder_id && store.folders.some(folder => !isDeletedStorageRecord(folder) && folder.id == folder_id) ? folder_id : '';
    let moved_connection = null;

    for (const connection of store.connections) {
        if (!isDeletedStorageRecord(connection) && connection.id == connection_id) {
            connection.folder_id = target_folder_id;
            connection.updated_at = now;
            moved_connection = connection;
            break;
        }
    }

    if (!moved_connection) {
        return;
    }

    if (target_folder_id) {
        const folder = store.folders.find(candidate => !isDeletedStorageRecord(candidate) && candidate.id == target_folder_id);
        if (folder) {
            folder.expanded = true;
            folder.updated_at = now;
        }
    }

    if (!saveConnectionStore(store)) {
        return;
    }
    if (current_connection_id == moved_connection.id) {
        updateNavigatorFooter(moved_connection);
        updateActiveConnectionBanner(moved_connection);
    }
    renderNavigatorTree();
}

function renderConnectionFolderOptions(selected_folder_id = '') {
    while (connection_folder_select_elem.firstChild) {
        connection_folder_select_elem.removeChild(connection_folder_select_elem.lastChild);
    }

    const top_level_option = document.createElement('option');
    top_level_option.value = '';
    top_level_option.innerText = 'Top level';
    connection_folder_select_elem.appendChild(top_level_option);

    for (const folder of getSavedConnectionFolders()) {
        const option = document.createElement('option');
        option.value = folder.id;
        option.innerText = folder.name;
        connection_folder_select_elem.appendChild(option);
    }

    connection_folder_select_elem.value = getConnectionFolder(selected_folder_id) ? selected_folder_id : '';
}

function loadNavigatorState() {
    try {
        const stored = JSON.parse(window.localStorage.getItem(navigator_state_key) || '{}');
        return {
            connections: stored && typeof stored.connections == 'object' ? stored.connections : {},
            databases: stored && typeof stored.databases == 'object' ? stored.databases : {},
            groups: stored && typeof stored.groups == 'object' ? stored.groups : {},
            // Keep table nodes collapsed on load rather than restoring prior expansion state.
            tables: {}
        };
    } catch (e) {
        return { connections: {}, databases: {}, groups: {}, tables: {} };
    }
}

function saveNavigatorState() {
    window.localStorage.setItem(navigator_state_key, JSON.stringify({
        ...navigator_state,
        tables: {}
    }));
}

function createQuerySnippetId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function loadQuerySnippets() {
    const result = readVersionedStorage(query_snippets_key, emptyQuerySnippetStore);
    return normalizeQuerySnippetStore(result.store);
}

function emptyQuerySnippetStore() {
    return createVersionedStorageEnvelope({ folders: [], snippets: [] });
}

function normalizeQuerySnippetStore(stored) {
    const store_updated_at = String(stored?.updated_at || '');
    const raw_folders = stored && Array.isArray(stored.folders) ? stored.folders : [];
    const folders = [];
    const active_folder_ids = new Set();

    for (const [folder_index, folder] of raw_folders.entries()) {
        if (!folder || !folder.id || !folder.name || folders.some(candidate => candidate.id == String(folder.id))) {
            continue;
        }

        const normalized_folder = {
            id: String(folder.id),
            name: String(folder.name),
            expanded: folder.expanded !== false,
            order: getSnippetRecordOrder(folder, folder_index),
            updated_at: String(folder.updated_at || folder.deleted_at || store_updated_at),
            deleted_at: String(folder.deleted_at || '')
        };
        folders.push(normalized_folder);
        if (!isDeletedStorageRecord(normalized_folder)) {
            active_folder_ids.add(normalized_folder.id);
        }
    }

    const raw_snippets = stored && Array.isArray(stored.snippets) ? stored.snippets : [];
    const snippets = [];
    const snippet_ids = new Set();

    for (const [snippet_index, snippet] of raw_snippets.entries()) {
        if (!snippet || !snippet.id || !snippet.folder_id || !snippet.name || snippet_ids.has(String(snippet.id))) {
            continue;
        }

        const folder_id = String(snippet.folder_id);
        if (!active_folder_ids.has(folder_id) && !isDeletedStorageRecord(snippet)) {
            continue;
        }

        const normalized_snippet = {
            id: String(snippet.id),
            folder_id: folder_id,
            name: String(snippet.name),
            query: String(snippet.query || ''),
            order: getSnippetRecordOrder(snippet, snippet_index),
            updated_at: String(snippet.updated_at || snippet.deleted_at || store_updated_at),
            deleted_at: String(snippet.deleted_at || '')
        };
        snippets.push(normalized_snippet);
        snippet_ids.add(normalized_snippet.id);
    }

    return createVersionedStorageEnvelope({ folders: folders, snippets: snippets });
}

function saveQuerySnippets() {
    const latest_result = readVersionedStorage(query_snippets_key, emptyQuerySnippetStore);
    if (latest_result.unsupported_schema) {
        alertUnsupportedStorageSchema('Query snippets', latest_result.schema_version);
        return false;
    }

    const latest_store = normalizeQuerySnippetStore(latest_result.store);
    const local_store = normalizeQuerySnippetStore(query_snippets_state);
    const merged_store = createVersionedStorageEnvelope({
        folders: mergeStorageRecords(latest_store.folders, local_store.folders),
        snippets: mergeStorageRecords(latest_store.snippets, local_store.snippets)
    });

    window.localStorage.setItem(query_snippets_key, JSON.stringify(merged_store));
    query_snippets_state = normalizeQuerySnippetStore(merged_store);
    return true;
}

function getSnippetRecordOrder(record, fallback_order) {
    const order = Number(record?.order);
    return Number.isFinite(order) ? order : fallback_order;
}

function sortSnippetRecordsByOrder(records) {
    return records
        .map((record, index) => ({ record: record, index: index }))
        .sort((a, b) => {
            const order_delta = getSnippetRecordOrder(a.record, a.index) - getSnippetRecordOrder(b.record, b.index);
            if (order_delta != 0) {
                return order_delta;
            }
            return a.index - b.index;
        })
        .map(entry => entry.record);
}

function getNextSnippetOrder(records) {
    if (!records.length) {
        return 0;
    }

    return Math.max(...records.map((record, index) => getSnippetRecordOrder(record, index))) + 1;
}

function getVisibleSnippetFolders() {
    return sortSnippetRecordsByOrder(query_snippets_state.folders.filter(folder => !isDeletedStorageRecord(folder)));
}

function getVisibleSnippets() {
    return sortSnippetRecordsByOrder(query_snippets_state.snippets.filter(snippet => !isDeletedStorageRecord(snippet)));
}

function findSnippetFolderByName(name) {
    const normalized_name = name.trim().toLowerCase();
    return getVisibleSnippetFolders().find(folder => folder.name.toLowerCase() == normalized_name) || null;
}
