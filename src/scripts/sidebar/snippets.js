function createSnippetFolder(name, expanded = true) {
    const now = getStorageTimestamp();
    const folder = {
        id: createQuerySnippetId('folder'),
        name: name.trim(),
        expanded: expanded,
        order: getNextSnippetOrder(getVisibleSnippetFolders()),
        updated_at: now,
        deleted_at: ''
    };
    query_snippets_state.folders.push(folder);
    return folder;
}

function ensureSnippetFolder(name = 'General') {
    const visible_folders = getVisibleSnippetFolders();
    if (visible_folders.length) {
        return visible_folders[0];
    }

    return createSnippetFolder(name);
}

function getSnippetFolder(folder_id) {
    return getVisibleSnippetFolders().find(folder => folder.id == folder_id) || null;
}

function getSnippet(snippet_id) {
    return getVisibleSnippets().find(snippet => snippet.id == snippet_id) || null;
}

function getSnippetFolderSnippets(folder_id) {
    return getVisibleSnippets().filter(snippet => snippet.folder_id == folder_id);
}

function createSnippetIcon(icon_name) {
    const path_data_by_icon = {
        bookmark: [
            'M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'
        ]
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    for (const path_data of path_data_by_icon[icon_name] || []) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', path_data);
        svg.appendChild(path);
    }

    return svg;
}

function formatSnippetExportFilenameTimestamp(timestamp) {
    return timestamp
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:/g, '-');
}

function buildSnippetExportCollection() {
    const folders = getVisibleSnippetFolders().map(folder => ({
        id: folder.id,
        name: folder.name,
        expanded: folder.expanded !== false,
        order: folder.order,
        updated_at: folder.updated_at || ''
    }));
    const folder_ids = new Set(folders.map(folder => folder.id));
    const snippets = getVisibleSnippets()
        .filter(snippet => folder_ids.has(snippet.folder_id))
        .map(snippet => ({
            id: snippet.id,
            folder_id: snippet.folder_id,
            name: snippet.name,
            query: snippet.query,
            order: snippet.order,
            updated_at: snippet.updated_at || ''
        }));

    return {
        collection_type: 'click-play-boom.query-snippets',
        schema_version: storage_schema_version,
        exported_at: getStorageTimestamp(),
        folders: folders,
        snippets: snippets
    };
}

function exportSnippetCollection() {
    const collection = buildSnippetExportCollection();
    if (!collection.folders.length && !collection.snippets.length) {
        alert('No snippets to export.');
        return;
    }

    const filename = `click-play-boom-snippets-${formatSnippetExportFilenameTimestamp(collection.exported_at)}.json`;
    downloadTextFile(filename, JSON.stringify(collection, null, 2), 'application/json;charset=utf-8');
}

function normalizeImportedStorageTimestamp(value, fallback) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeImportedSnippetCollection(raw_collection) {
    if (!raw_collection || typeof raw_collection != 'object') {
        return { folders: [], snippets: [] };
    }

    const raw_folders = Array.isArray(raw_collection.folders) ? raw_collection.folders : [];
    const raw_snippets = Array.isArray(raw_collection.snippets) ? raw_collection.snippets : [];
    const folders = [];
    const source_folder_ids = new Set();

    for (const folder of raw_folders) {
        if (!folder || !folder.name) {
            continue;
        }

        let source_id = String(folder.id || `folder-${folders.length + 1}`);
        while (source_folder_ids.has(source_id)) {
            source_id = `${source_id}-${folders.length + 1}`;
        }

        source_folder_ids.add(source_id);
        folders.push({
            source_id: source_id,
            name: String(folder.name),
            expanded: folder.expanded !== false,
            order: getSnippetRecordOrder(folder, folders.length),
            updated_at: String(folder.updated_at || '')
        });
    }

    const has_importable_snippets = raw_snippets.some(snippet => snippet && (snippet.name || snippet.query !== undefined));
    if (!folders.length && has_importable_snippets) {
        folders.push({
            source_id: '__imported__',
            name: 'Imported snippets',
            expanded: true,
            updated_at: ''
        });
    }

    const fallback_folder_id = folders[0]?.source_id || '';
    const snippets = [];
    const source_snippet_ids = new Set();

    for (const snippet of raw_snippets) {
        if (!snippet || (!snippet.name && snippet.query === undefined)) {
            continue;
        }

        let source_id = String(snippet.id || `snippet-${snippets.length + 1}`);
        while (source_snippet_ids.has(source_id)) {
            source_id = `${source_id}-${snippets.length + 1}`;
        }

        source_snippet_ids.add(source_id);
        snippets.push({
            source_id: source_id,
            source_folder_id: String(snippet.folder_id || fallback_folder_id),
            name: String(snippet.name || 'Imported snippet'),
            query: String(snippet.query || ''),
            order: getSnippetRecordOrder(snippet, snippets.length),
            updated_at: String(snippet.updated_at || '')
        });
    }

    return {
        folders: sortSnippetRecordsByOrder(folders),
        snippets: sortSnippetRecordsByOrder(snippets)
    };
}

function getAvailableSnippetRecordId(preferred_id, prefix, used_ids) {
    let id = String(preferred_id || '');
    if (!id || used_ids.has(id)) {
        id = createQuerySnippetId(prefix);
    }

    while (used_ids.has(id)) {
        id = createQuerySnippetId(prefix);
    }

    used_ids.add(id);
    return id;
}

function importSnippetCollection(raw_collection) {
    query_snippets_state = loadQuerySnippets();
    const collection = normalizeImportedSnippetCollection(raw_collection);
    if (!collection.folders.length && !collection.snippets.length) {
        alert('No snippets found in that import file.');
        return false;
    }

    const now = getStorageTimestamp();
    const folder_ids = new Set(query_snippets_state.folders.map(folder => folder.id));
    const snippet_ids = new Set(query_snippets_state.snippets.map(snippet => snippet.id));
    const folder_id_map = new Map();
    let imported_folder_count = 0;
    let imported_snippet_count = 0;
    let next_folder_order = getNextSnippetOrder(getVisibleSnippetFolders());

    for (const folder of collection.folders) {
        const folder_id = getAvailableSnippetRecordId(folder.source_id, 'folder', folder_ids);
        folder_id_map.set(folder.source_id, folder_id);
        query_snippets_state.folders.push({
            id: folder_id,
            name: folder.name,
            expanded: folder.expanded !== false,
            order: next_folder_order++,
            updated_at: normalizeImportedStorageTimestamp(folder.updated_at, now),
            deleted_at: ''
        });
        ++imported_folder_count;
    }

    const fallback_folder_id = query_snippets_state.folders
        .filter(folder => !isDeletedStorageRecord(folder))
        .at(-1)?.id || '';
    const next_snippet_order_by_folder = new Map();

    for (const snippet of collection.snippets) {
        const folder_id = folder_id_map.get(snippet.source_folder_id) || fallback_folder_id;
        if (!folder_id) {
            continue;
        }

        if (!next_snippet_order_by_folder.has(folder_id)) {
            next_snippet_order_by_folder.set(folder_id, getNextSnippetOrder(getSnippetFolderSnippets(folder_id)));
        }
        const snippet_order = next_snippet_order_by_folder.get(folder_id);
        next_snippet_order_by_folder.set(folder_id, snippet_order + 1);

        query_snippets_state.snippets.push({
            id: getAvailableSnippetRecordId(snippet.source_id, 'snippet', snippet_ids),
            folder_id: folder_id,
            name: snippet.name,
            query: snippet.query,
            order: snippet_order,
            updated_at: normalizeImportedStorageTimestamp(snippet.updated_at, now),
            deleted_at: ''
        });
        ++imported_snippet_count;
    }

    if (!imported_folder_count && !imported_snippet_count) {
        alert('No snippets found in that import file.');
        return false;
    }

    if (!saveQuerySnippets()) {
        return false;
    }

    setSidebarTab('snippets');
    renderSnippets();
    alert(`Imported ${imported_snippet_count} snippet${imported_snippet_count == 1 ? '' : 's'} in ${imported_folder_count} folder${imported_folder_count == 1 ? '' : 's'}.`);
    return true;
}

async function importSnippetCollectionFile(file) {
    if (!file) {
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch (e) {
        alert('That snippet import file is not valid JSON.');
        return;
    }

    importSnippetCollection(parsed);
}

function setSidebarTab(tab_name, persist = true) {
    const next_tab = ['navigator', 'snippets', 'history'].includes(tab_name) ? tab_name : 'navigator';

    for (const tab of document.querySelectorAll('[data-sidebar-tab]')) {
        tab.classList.toggle('active', tab.dataset.sidebarTab == next_tab);
    }
    for (const panel of document.querySelectorAll('[data-sidebar-panel]')) {
        panel.classList.toggle('active', panel.dataset.sidebarPanel == next_tab);
    }

    if (persist) {
        window.localStorage.setItem(sidebar_active_tab_key, next_tab);
    }
}

function formatSnippetPreview(query) {
    return query.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty query)';
}

async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText == 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // Fall back to a temporary textarea below.
        }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
        copied = document.execCommand('copy');
    } finally {
        document.body.removeChild(textarea);
    }

    return copied;
}

function promptSnippetFolder(default_folder = null) {
    const visible_folders = getVisibleSnippetFolders();
    const fallback_folder = default_folder || visible_folders[0] || { name: 'General' };
    const folder_name = prompt('Folder name', fallback_folder.name);
    if (folder_name === null) {
        return null;
    }

    const trimmed_name = folder_name.trim();
    if (!trimmed_name) {
        return default_folder || visible_folders[0] || createSnippetFolder('General');
    }

    const existing_folder = findSnippetFolderByName(trimmed_name);
    if (existing_folder) {
        return existing_folder;
    }

    return createSnippetFolder(trimmed_name);
}

function saveCurrentQueryAsSnippet(default_folder = null) {
    const query = query_area.value;
    if (!query.trim()) {
        alert('There is no query to save.');
        return;
    }

    const first_line = query.trim().split('\n').find(Boolean) || 'Saved query';
    const snippet_name = prompt('Snippet name', first_line.slice(0, 80));
    if (snippet_name === null) {
        return;
    }

    const trimmed_name = snippet_name.trim();
    if (!trimmed_name) {
        alert('Snippet name is required.');
        return;
    }

    const folder = default_folder || promptSnippetFolder();
    if (!folder) {
        return;
    }

    const now = getStorageTimestamp();
    query_snippets_state.snippets.push({
        id: createQuerySnippetId('snippet'),
        folder_id: folder.id,
        name: trimmed_name,
        query: query,
        order: getNextSnippetOrder(getSnippetFolderSnippets(folder.id)),
        updated_at: now,
        deleted_at: ''
    });
    folder.expanded = true;
    folder.updated_at = now;
    if (!saveQuerySnippets()) {
        return;
    }
    setSidebarTab('snippets');
    renderSnippets();
}

function createSnippetFolderFromPrompt() {
    const folder_name = prompt('Folder name', 'New folder');
    if (folder_name === null) {
        return;
    }

    const trimmed_name = folder_name.trim();
    if (!trimmed_name) {
        alert('Folder name is required.');
        return;
    }

    if (findSnippetFolderByName(trimmed_name)) {
        alert('A folder with that name already exists.');
        return;
    }

    createSnippetFolder(trimmed_name);
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function renameSnippetFolder(folder_id) {
    const folder = getSnippetFolder(folder_id);
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

    const existing_folder = findSnippetFolderByName(trimmed_name);
    if (existing_folder && existing_folder.id != folder.id) {
        alert('A folder with that name already exists.');
        return;
    }

    folder.name = trimmed_name;
    folder.updated_at = getStorageTimestamp();
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function deleteSnippetFolder(folder_id) {
    const folder = getSnippetFolder(folder_id);
    if (!folder) {
        return;
    }

    const snippet_count = getSnippetFolderSnippets(folder.id).length;
    const suffix = snippet_count == 1 ? '1 snippet' : `${snippet_count} snippets`;
    if (!confirm(`Delete "${folder.name}" and ${suffix}?`)) {
        return;
    }

    const now = getStorageTimestamp();
    folder.updated_at = now;
    folder.deleted_at = now;
    for (const snippet of query_snippets_state.snippets) {
        if (!isDeletedStorageRecord(snippet) && snippet.folder_id == folder.id) {
            snippet.updated_at = now;
            snippet.deleted_at = now;
        }
    }
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function renameSnippet(snippet_id) {
    const snippet = getSnippet(snippet_id);
    if (!snippet) {
        return;
    }

    const snippet_name = prompt('Snippet name', snippet.name);
    if (snippet_name === null) {
        return;
    }

    const trimmed_name = snippet_name.trim();
    if (!trimmed_name) {
        alert('Snippet name is required.');
        return;
    }

    snippet.name = trimmed_name;
    snippet.updated_at = getStorageTimestamp();
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function updateSnippetFromEditor(snippet_id) {
    const snippet = getSnippet(snippet_id);
    if (!snippet) {
        return;
    }

    if (!query_area.value.trim()) {
        alert('There is no query to save.');
        return;
    }

    snippet.query = query_area.value;
    snippet.updated_at = getStorageTimestamp();
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function deleteSnippet(snippet_id) {
    const snippet = getSnippet(snippet_id);
    if (!snippet) {
        return;
    }

    if (!confirm(`Delete "${snippet.name}"?`)) {
        return;
    }

    const now = getStorageTimestamp();
    snippet.updated_at = now;
    snippet.deleted_at = now;
    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function swapSnippetRecordOrder(records, index, target_index) {
    if (index < 0 || target_index < 0 || index >= records.length || target_index >= records.length) {
        return false;
    }

    const now = getStorageTimestamp();
    const record = records[index];
    const target_record = records[target_index];
    const record_order = getSnippetRecordOrder(record, index);
    const target_order = getSnippetRecordOrder(target_record, target_index);
    record.order = target_order;
    target_record.order = record_order;
    record.updated_at = now;
    target_record.updated_at = now;
    return true;
}

function getSnippetFolderMoveState(folder_id) {
    const folders = getVisibleSnippetFolders();
    const index = folders.findIndex(folder => folder.id == folder_id);
    return {
        index: index,
        can_move_up: index > 0,
        can_move_down: index >= 0 && index < folders.length - 1
    };
}

function moveSnippetFolder(folder_id, direction) {
    const folders = getVisibleSnippetFolders();
    const index = folders.findIndex(folder => folder.id == folder_id);
    if (!swapSnippetRecordOrder(folders, index, index + direction)) {
        return;
    }

    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}

function getSnippetMoveState(snippet_id) {
    const snippet = getSnippet(snippet_id);
    const snippets = snippet ? getSnippetFolderSnippets(snippet.folder_id) : [];
    const index = snippets.findIndex(candidate => candidate.id == snippet_id);
    return {
        index: index,
        can_move_up: index > 0,
        can_move_down: index >= 0 && index < snippets.length - 1
    };
}

function moveSnippet(snippet_id, direction) {
    const snippet = getSnippet(snippet_id);
    if (!snippet) {
        return;
    }

    const snippets = getSnippetFolderSnippets(snippet.folder_id);
    const index = snippets.findIndex(candidate => candidate.id == snippet_id);
    if (!swapSnippetRecordOrder(snippets, index, index + direction)) {
        return;
    }

    if (!saveQuerySnippets()) {
        return;
    }
    renderSnippets();
}
