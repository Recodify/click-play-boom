function setColorTheme(new_theme, update_preference) {
    theme = new_theme;
    if (update_preference) {
        window.localStorage.setItem('theme', theme);
    }
    document.documentElement.setAttribute('data-theme', theme);
    redrawChart();
    redrawDashboardCharts();
    redrawSchemaGraph();
}
/// First we check if theme is set via the 'theme' GET parameter, if not, we check localStorage, otherwise we check OS preference.
let theme = current_url.searchParams.get('theme');
if (['dark', 'light'].indexOf(theme) === -1) {
    theme = window.localStorage.getItem('theme');
}

if (theme) {
    document.documentElement.setAttribute('data-theme', theme);
} else {
    /// Obtain system-level user preference
    const media_query_list = window.matchMedia('(prefers-color-scheme: dark)');
    if (media_query_list.matches) {
        setColorTheme('dark');
    } else {
        setColorTheme('light');
    }

    /// There is a rumor that on some computers, the theme is changing automatically on day/night.
    media_query_list.addEventListener('change', function(e) {
        setColorTheme(e.matches ? 'dark' : 'light');
    });
}

document.getElementById('new-connection').addEventListener('click', () => {
    openConnectionEditor();
});

new_connection_folder_elem.addEventListener('click', () => {
    createConnectionFolderFromPrompt();
});

connection_editor_save_elem.addEventListener('click', () => {
    saveConnectionEditor();
});

connection_editor_cancel_elem.addEventListener('click', () => {
    closeConnectionEditor();
});

schema_compat_create_database_elem.addEventListener('change', updateSchemaCompatEditorMode);

schema_compat_new_database_elem.addEventListener('input', updateSchemaCompatEditorGenerateState);

schema_compat_database_elem.addEventListener('change', updateSchemaCompatEditorGenerateState);

schema_compat_editor_generate_elem.addEventListener('click', generateSchemaCompatTable);

schema_compat_editor_cancel_elem.addEventListener('click', closeSchemaCompatEditor);

schema_filter_elem.addEventListener('input', () => {
    renderNavigatorTree();
});

navigator_show_types_elem.addEventListener('change', () => {
    setNavigatorTypesVisible(navigator_show_types_elem.checked);
});

abort_preview_limit_elem.addEventListener('change', () => {
    setAbortPreviewLimit(abort_preview_limit_elem.checked);
});

refresh_schema_elem.addEventListener('click', () => {
    if (!current_connection_id) {
        return;
    }

    loadDatabases(url_elem.value, user_elem.value, password_elem.value);
});

for (const sidebar_tab of document.querySelectorAll('[data-sidebar-tab]')) {
    sidebar_tab.addEventListener('click', () => {
        setSidebarTab(sidebar_tab.dataset.sidebarTab);
    });
}

snippet_filter_elem.addEventListener('input', () => {
    renderSnippets();
});

new_snippet_folder_elem.addEventListener('click', () => {
    createSnippetFolderFromPrompt();
});

save_query_snippet_elem.addEventListener('click', () => {
    saveCurrentQueryAsSnippet();
});

export_snippets_elem.addEventListener('click', () => {
    exportSnippetCollection();
});

import_snippets_elem.addEventListener('click', () => {
    import_snippets_file_elem.click();
});

import_snippets_file_elem.addEventListener('change', async () => {
    try {
        await importSnippetCollectionFile(import_snippets_file_elem.files?.[0]);
    } finally {
        import_snippets_file_elem.value = '';
    }
});

document.getElementById('clear-history').addEventListener('click', () => {
    action_history = [];
    renderActionHistory();
});

setDownloadQueryCachePreference(window.localStorage.getItem(download_query_cache_key) === '1', false);
download_use_cache_elem.addEventListener('change', () => {
    setDownloadQueryCachePreference(download_use_cache_elem.checked);
});

setEditorCompact(window.localStorage.getItem(query_editor_compact_key) === '1', false);
setNavigatorTypesVisible(window.localStorage.getItem(navigator_show_types_key) === '1', false);
setSnippetInsertionMode(window.localStorage.getItem(snippet_insertion_mode_key) || 'append', false);
rememberQueryEditorSelection();
snippet_insertion_mode_elem.addEventListener('change', () => {
    setSnippetInsertionMode(snippet_insertion_mode_elem.value);
});
setAbortPreviewLimit(window.localStorage.getItem(abort_preview_limit_key) === '1', false);
setSidebarTab(window.localStorage.getItem(sidebar_active_tab_key) || 'navigator', false);
renderSnippets();
initializeWorkspaceViews();
initializeDashboardView();
initializeSchemaView();

const stored_sidebar_width = Number(window.localStorage.getItem(sidebar_width_key));
if (Number.isFinite(stored_sidebar_width) && stored_sidebar_width > 0) {
    setSidebarWidth(stored_sidebar_width, false);
}

appendSidebarResizer();

document.addEventListener('click', e => {
    if (!navigator_context_menu_elem.contains(e.target)) {
        hideNavigatorContextMenu();
    }
});
document.addEventListener('mousedown', e => {
    if (autocomplete_state.open && e.target != query_area && !autocomplete_menu_elem.contains(e.target)) {
        closeAutocomplete();
    }
});
document.addEventListener('keydown', e => {
    if (e.key == 'Escape') {
        hideNavigatorContextMenu();
        closeConnectionEditor();
    }
});
window.addEventListener('storage', handleLocalStorageChanged);

setSidebarCollapsed(window.localStorage.getItem(sidebar_collapsed_key) === '1', false);
loadConnections();
updateRunButtonText();
void updateQueryHighlighting();

if (run_immediately) {
    post();
}

document.getElementById('toggle-light').onclick = function() {
    setColorTheme('light', true);
}

document.getElementById('toggle-dark').onclick = function() {
    setColorTheme('dark', true);
}
