function getWorkspaceTabEntries() {
    return [
        { name: 'query', tab: app_view_query_elem, workspace: results_workspace_elem },
        { name: 'dashboard', tab: app_view_dashboard_elem, workspace: dashboard_workspace_elem },
        { name: 'schema', tab: app_view_schema_elem, workspace: schema_workspace_elem },
        { name: 'settings', tab: app_view_settings_elem, workspace: settings_workspace_elem }
    ];
}

function updateWorkspaceTabs() {
    for (const entry of getWorkspaceTabEntries()) {
        const active = current_workspace_view == entry.name;
        document.body.classList.toggle(`workspace-${entry.name}`, active);
        entry.tab.classList.toggle('active', active);
        entry.tab.setAttribute('aria-selected', active ? 'true' : 'false');
        entry.tab.tabIndex = active ? 0 : -1;
        entry.workspace.hidden = !active;
    }
    if (current_workspace_view != 'settings' && typeof closeSettingsCatalogCombobox == 'function') {
        closeSettingsCatalogCombobox('workspace');
    }
    if (typeof updateNavigatorSchemaActionAvailability == 'function') {
        updateNavigatorSchemaActionAvailability();
    }
}

function updateWorkspaceUrl(view) {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('view', view);
        window.history.replaceState(window.history.state, '', url);
    } catch (e) {
        // Some file:// contexts do not allow history mutation.
    }
}

function setWorkspaceView(view, options = {}) {
    current_workspace_view = ['dashboard', 'schema', 'settings'].includes(view) ? view : 'query';
    updateWorkspaceTabs();
    if (options.update_url !== false) {
        updateWorkspaceUrl(current_workspace_view);
    }

    if (current_workspace_view == 'dashboard') {
        void ensureDashboardLoaded(options);
    } else if (current_workspace_view == 'schema') {
        void ensureSchemaLoaded(options);
    } else if (current_workspace_view == 'settings') {
        void ensureSettingsLoaded(options);
    } else {
        resizeChart();
        query_area.focus();
    }
}

function handleWorkspaceTabKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
    }

    const entries = getWorkspaceTabEntries();
    const current_index = entries.findIndex(entry => entry.tab == event.currentTarget);
    let next_index = current_index;
    if (event.key == 'Home') {
        next_index = 0;
    } else if (event.key == 'End') {
        next_index = entries.length - 1;
    } else {
        const direction = event.key == 'ArrowRight' ? 1 : -1;
        next_index = (current_index + direction + entries.length) % entries.length;
    }

    event.preventDefault();
    setWorkspaceView(entries[next_index].name);
    entries[next_index].tab.focus();
}

function initializeWorkspaceViews() {
    for (const entry of getWorkspaceTabEntries()) {
        entry.tab.addEventListener('click', () => setWorkspaceView(entry.name));
        entry.tab.addEventListener('keydown', handleWorkspaceTabKeyDown);
    }
    updateWorkspaceTabs();
}
