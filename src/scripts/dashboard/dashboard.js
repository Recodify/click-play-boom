const dashboard_default_dashboard = 'Overview';
const dashboard_default_params = {
    rounding: '60',
    seconds: '86400',
    from: '',
    to: ''
};
const dashboard_default_param_desc = {
    from: {
        placeholder: '2023-01-01 00:00:00',
        title: 'Enter date in 2023-01-01 00:00:00 format. If empty, it is calculated from seconds.'
    },
    to: {
        placeholder: '2023-01-02 00:00:00',
        title: 'Enter date in 2023-01-01 00:00:00 format. If empty, it is current time.'
    },
    seconds: {
        placeholder: '86400',
        title: 'Number of seconds to look back from current time.'
    }
};
const dashboard_query_param_regexp = /\{(\w+):([^}]+)\}/g;
const dashboard_range_param_names = new Set(['seconds', 'from', 'to']);
const dashboard_rounding_param_name = 'rounding';
const dashboard_range_units = [
    { value: '1', label: 'seconds' },
    { value: '60', label: 'minutes' },
    { value: '3600', label: 'hours' },
    { value: '86400', label: 'days' }
];

const dashboard_state = {
    connection_id: '',
    initialized: false,
    loading: false,
    drawing: false,
    mass_editor_active: false,
    generation: 0,
    dashboard_queries: {},
    search_query: '',
    customized: false,
    queries: [],
    params: { ...dashboard_default_params },
    plots: [],
    active_chart_index: null,
    param_reload_timer: null
};

function escapeDashboardString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getDashboardSearchQuery(dashboard_name) {
    return `SELECT title, query FROM system.dashboards WHERE dashboard = '${escapeDashboardString(dashboard_name)}'`;
}

function resetDashboardStateForConnection(connection = getCurrentDashboardConnection()) {
    clearDashboardParamReloadTimer();
    destroyDashboardPlots();
    dashboard_state.connection_id = connection.id || '';
    dashboard_state.generation++;
    dashboard_state.dashboard_queries = {
        [dashboard_default_dashboard]: getDashboardSearchQuery(dashboard_default_dashboard)
    };
    dashboard_state.search_query = dashboard_state.dashboard_queries[dashboard_default_dashboard];
    dashboard_state.customized = false;
    dashboard_state.queries = [];
    dashboard_state.params = { ...dashboard_default_params };
    dashboard_state.plots = [];
    dashboard_state.active_chart_index = null;
    dashboard_state.mass_editor_active = false;
    dashboard_charts_elem.innerHTML = '';
    renderDashboardSelectorOptions();
    dashboardHideMassEditor();
    dashboardHideGlobalError();
    updateDashboardControlsFromState();
}

function getCurrentDashboardConnection() {
    return {
        id: current_connection_id || '',
        name: current_connection_name || 'Connection',
        url: url_elem.value || 'http://localhost:8123/',
        user: user_elem.value || 'default',
        password: password_elem.value || ''
    };
}

function updateWorkspaceTabs() {
    const is_query = current_workspace_view == 'query';
    const is_dashboard = current_workspace_view == 'dashboard';
    const is_schema = current_workspace_view == 'schema';
    document.body.classList.toggle('workspace-query', is_query);
    document.body.classList.toggle('workspace-dashboard', is_dashboard);
    document.body.classList.toggle('workspace-schema', is_schema);
    app_view_query_elem.classList.toggle('active', is_query);
    app_view_dashboard_elem.classList.toggle('active', is_dashboard);
    app_view_schema_elem.classList.toggle('active', is_schema);
    app_view_query_elem.setAttribute('aria-selected', is_query ? 'true' : 'false');
    app_view_dashboard_elem.setAttribute('aria-selected', is_dashboard ? 'true' : 'false');
    app_view_schema_elem.setAttribute('aria-selected', is_schema ? 'true' : 'false');
    dashboard_workspace_elem.hidden = !is_dashboard;
    schema_workspace_elem.hidden = !is_schema;
    results_workspace_elem.hidden = !is_query;
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
    current_workspace_view = ['dashboard', 'schema'].includes(view) ? view : 'query';
    updateWorkspaceTabs();
    if (options.update_url !== false) {
        updateWorkspaceUrl(current_workspace_view);
    }

    if (current_workspace_view == 'dashboard') {
        void ensureDashboardLoaded(options);
    } else if (current_workspace_view == 'schema') {
        void ensureSchemaLoaded(options);
    } else {
        resizeChart();
        query_area.focus();
    }
}

function initializeWorkspaceViews() {
    app_view_query_elem.addEventListener('click', () => setWorkspaceView('query'));
    app_view_dashboard_elem.addEventListener('click', () => setWorkspaceView('dashboard'));
    app_view_schema_elem.addEventListener('click', () => setWorkspaceView('schema'));
    updateWorkspaceTabs();
}

function initializeDashboardView() {
    if (dashboard_state.initialized) {
        return;
    }

    dashboard_state.initialized = true;
    resetDashboardStateForConnection();

    dashboard_controls_elem.addEventListener('submit', event => {
        event.preventDefault();
        void reloadDashboard(dashboard_state.queries.length == 0);
    });

    dashboard_reload_elem.addEventListener('click', () => {
        void reloadDashboard(dashboard_state.queries.length == 0);
    });

    dashboard_reset_zoom_elem.addEventListener('click', () => {
        resetDashboardZoom();
    });

    dashboard_search_query_elem.addEventListener('change', () => {
        void reloadDashboard(true);
    });

    dashboard_add_elem.addEventListener('click', () => {
        dashboard_state.queries.push({ title: '', query: '' });
        const { chart, textarea } = insertDashboardChart(dashboard_state.plots.length);
        dashboard_state.plots.push(null);
        dashboardResizeCharts();
        chart.scrollIntoView({ block: 'nearest' });
        textarea.focus();
    });

    dashboard_edit_elem.addEventListener('click', () => {
        if (dashboard_state.mass_editor_active) {
            applyDashboardMassEditorChanges();
        } else {
            showDashboardMassEditor();
        }
    });

    dashboard_mass_editor_confirm_elem.addEventListener('click', () => {
        applyDashboardMassEditorChanges();
    });

    dashboard_mass_editor_cancel_elem.addEventListener('click', () => {
        dashboardHideMassEditor();
    });

    dashboard_mass_editor_textarea_elem.addEventListener('input', validateDashboardMassEditor);

    document.addEventListener('keydown', handleDashboardKeyDown);

    new ResizeObserver(dashboardResizeCharts).observe(dashboard_workspace_elem);
}

async function ensureDashboardLoaded({ reload = false } = {}) {
    initializeDashboardView();
    const connection = getCurrentDashboardConnection();
    if (dashboard_state.connection_id != connection.id) {
        resetDashboardStateForConnection(connection);
    }

    if (reload) {
        resetDashboardStateForConnection(connection);
    }

    if (dashboard_state.loading) {
        return;
    }

    if (dashboard_state.queries.length == 0) {
        await reloadDashboard(true);
    } else {
        await drawAllDashboardCharts();
    }
}

function handleDashboardConnectionChanged(connection) {
    if (!dashboard_state.initialized) {
        return;
    }

    resetDashboardStateForConnection(connection);
    if (current_workspace_view == 'dashboard') {
        void ensureDashboardLoaded({ reload: true });
    }
}

function openDashboardForConnection(connection) {
    if (connection && connection.id != current_connection_id && typeof applyConnection == 'function') {
        applyConnection(connection);
    }
    setWorkspaceView('dashboard', { reload: true });
}

function setDashboardButtonsDisabled(disabled) {
    dashboard_state.loading = disabled;
    for (const button of [dashboard_reload_elem, dashboard_reset_zoom_elem, dashboard_add_elem, dashboard_edit_elem]) {
        button.disabled = disabled;
    }
    dashboard_search_query_elem.disabled = disabled;
    dashboard_reload_elem.title = disabled ? 'Reloading dashboard' : 'Reload dashboard';
    dashboard_reload_elem.setAttribute('aria-label', disabled ? 'Reloading dashboard' : 'Reload dashboard');
}

function dashboardShowGlobalError(message) {
    dashboard_error_elem.textContent = message || 'Dashboard failed.';
    dashboard_error_elem.hidden = false;
}

function dashboardHideGlobalError() {
    dashboard_error_elem.textContent = '';
    dashboard_error_elem.hidden = true;
}

function dashboardRefreshCustomized(value) {
    if (value !== undefined) {
        dashboard_state.customized = value;
    }
    dashboard_search_span_elem.style.opacity = dashboard_state.customized ? 0.55 : 1;
}

function updateDashboardControlsFromState() {
    renderDashboardSelectorOptions();
    dashboard_search_query_elem.value = fromDashboardSearchQuery(dashboard_state.search_query);
    dashboardRefreshCustomized();
    buildDashboardParams();
}

function renderDashboardSelectorOptions() {
    const current_value = fromDashboardSearchQuery(dashboard_state.search_query);
    dashboard_search_query_elem.innerHTML = '';

    const dashboard_names = Object.keys(dashboard_state.dashboard_queries);
    for (const dashboard_name of dashboard_names) {
        const option = document.createElement('option');
        option.value = dashboard_name;
        option.textContent = dashboard_name;
        dashboard_search_query_elem.appendChild(option);
    }

    if (current_value && !dashboard_names.includes(current_value)) {
        const option = document.createElement('option');
        option.value = current_value;
        option.textContent = current_value;
        dashboard_search_query_elem.appendChild(option);
    }
}

function fromDashboardSearchQuery(query) {
    for (const [dashboard_name, dashboard_query] of Object.entries(dashboard_state.dashboard_queries)) {
        if (query == dashboard_query) {
            return dashboard_name;
        }
    }
    return query;
}

function toDashboardSearchQuery(value) {
    if (Object.prototype.hasOwnProperty.call(dashboard_state.dashboard_queries, value)) {
        return dashboard_state.dashboard_queries[value];
    }
    return value;
}

async function dashboardFetch(query, extra_params = {}) {
    const connection = getCurrentDashboardConnection();
    const url = buildClickHouseUrl(connection.url, connection.user, connection.password, 'JSONColumnsWithMetadata', {
        enable_http_compression: '1',
        ...extra_params
    });

    const response = await fetch(url, {
        method: 'POST',
        body: query,
        headers: { 'Authorization': 'never' }
    });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(text || 'Dashboard query failed.');
    }

    let reply;
    try {
        reply = JSON.parse(text);
    } catch (e) {
        throw new Error(text || e.toString());
    }

    if (reply.exception) {
        throw new Error(reply.exception);
    }

    return normalizeDashboardReply(reply);
}

function normalizeDashboardReply(reply) {
    if (!reply || !Array.isArray(reply.meta)) {
        return reply;
    }

    if (Array.isArray(reply.data)) {
        const row_count = reply.data.length;
        const columns = {};
        for (const column of reply.meta) {
            columns[column.name] = [];
        }
        for (const row of reply.data) {
            for (const column of reply.meta) {
                columns[column.name].push(row[column.name]);
            }
        }
        reply.data = columns;
        reply.rows = reply.rows ?? row_count;
    }

    return reply;
}

function getDashboardReplyColumn(reply, name) {
    return reply?.data && Array.isArray(reply.data[name]) ? reply.data[name] : [];
}

async function populateDashboardOptions() {
    const reply = await dashboardFetch('SELECT dashboard FROM system.dashboards GROUP BY dashboard ORDER BY ALL');
    const dashboards = getDashboardReplyColumn(reply, 'dashboard');
    if (!dashboards.length) {
        return;
    }

    dashboard_state.dashboard_queries = {};
    for (const dashboard of dashboards) {
        dashboard_state.dashboard_queries[dashboard] = getDashboardSearchQuery(dashboard);
    }
    updateDashboardControlsFromState();
}

async function searchDashboardQueries() {
    const reply = await dashboardFetch(dashboard_state.search_query);
    if (!reply?.rows) {
        throw new Error('Search query returned empty result.');
    }
    if (!Array.isArray(reply.meta) || reply.meta.length != 2 || reply.meta[0].name != 'title' || reply.meta[1].name != 'query') {
        throw new Error('Search query should return exactly two columns: title and query.');
    }

    const titles = getDashboardReplyColumn(reply, 'title');
    const queries = getDashboardReplyColumn(reply, 'query');
    if (titles.length != queries.length) {
        throw new Error('Wrong data format of the search query.');
    }

    dashboard_state.queries = [];
    for (let i = 0; i < titles.length; i++) {
        dashboard_state.queries.push({ title: titles[i], query: queries[i] });
    }
    regenerateDashboardCharts();
}

async function reloadDashboard(do_search) {
    const generation = dashboard_state.generation;
    setDashboardButtonsDisabled(true);

    try {
        updateDashboardParams();
        if (do_search) {
            dashboard_state.search_query = toDashboardSearchQuery(dashboard_search_query_elem.value);
            dashboard_state.queries = [];
            dashboardRefreshCustomized(false);
        }
        if (do_search) {
            await populateDashboardOptions().catch(error => console.log(error));
            await searchDashboardQueries();
        }
        if (generation == dashboard_state.generation) {
            await drawAllDashboardCharts();
        }
    } catch (e) {
        console.log(e);
        dashboardShowGlobalError(e.message || e.toString());
    } finally {
        setDashboardButtonsDisabled(false);
    }
}

function getDashboardParamDefault(type) {
    if (type.includes('Int')) return '0';
    if (type.includes('Float')) return '0.0';
    if (type.includes('Bool')) return 'false';
    if (type.includes('Date')) return new Date().toISOString().slice(0, 10);
    if (type.includes('UUID')) return '00000000-0000-0000-0000-000000000000';
    return '';
}

function findDashboardParamsInQuery(query, next_params) {
    const temp_params = {};
    for (const match of String(query || '').matchAll(dashboard_query_param_regexp)) {
        const name = match[1];
        temp_params[name] = dashboard_state.params[name] || dashboard_default_params[name] || getDashboardParamDefault(match[2]);
    }

    for (const key of Object.keys(dashboard_default_params)) {
        if (Object.prototype.hasOwnProperty.call(temp_params, key)) {
            next_params[key] = temp_params[key];
        }
    }

    for (const key of Object.keys(temp_params)) {
        if (!Object.prototype.hasOwnProperty.call(dashboard_default_params, key)) {
            next_params[key] = temp_params[key];
        }
    }
}

function findDashboardParamsInQueries() {
    const next_params = {};
    for (const query of dashboard_state.queries) {
        findDashboardParamsInQuery(query.query, next_params);
    }
    dashboard_state.params = next_params;
}

function buildDashboardParams() {
    dashboard_params_elem.innerHTML = '';

    if (hasDashboardRangeParams()) {
        dashboard_params_elem.appendChild(createDashboardRangeControls());
    }

    if (hasDashboardRoundingParam()) {
        if (hasDashboardRangeParams()) {
            dashboard_params_elem.appendChild(createDashboardToolbarDivider());
        }
        dashboard_params_elem.appendChild(createDashboardRoundingControl());
    }

    const custom_params = Object.entries(dashboard_state.params)
        .filter(([name]) => !dashboard_range_param_names.has(name) && name != dashboard_rounding_param_name);
    if (custom_params.length) {
        const custom_wrapper = document.createElement('div');
        custom_wrapper.className = 'dashboard-custom-params';
        const custom_label = document.createElement('span');
        custom_label.className = 'dashboard-custom-params-label';
        custom_label.textContent = 'Params';
        custom_wrapper.appendChild(custom_label);

        for (const [name, value] of custom_params) {
            custom_wrapper.appendChild(createDashboardParamInput(name, value));
        }
        dashboard_params_elem.appendChild(custom_wrapper);
    }
}

function createDashboardToolbarDivider() {
    const divider = document.createElement('span');
    divider.className = 'dashboard-toolbar-divider dashboard-param-divider';
    divider.setAttribute('aria-hidden', 'true');
    return divider;
}

function updateDashboardParams() {
    updateDashboardRangeParams();
    for (const input of dashboard_params_elem.querySelectorAll('.dashboard-param-input')) {
        dashboard_state.params[input.name] = input.value;
    }
}

function hasDashboardRangeParams() {
    return ['seconds', 'from', 'to'].some(name => Object.prototype.hasOwnProperty.call(dashboard_state.params, name));
}

function hasDashboardRoundingParam() {
    return Object.prototype.hasOwnProperty.call(dashboard_state.params, dashboard_rounding_param_name);
}

function clearDashboardParamReloadTimer() {
    if (dashboard_state.param_reload_timer) {
        clearTimeout(dashboard_state.param_reload_timer);
        dashboard_state.param_reload_timer = null;
    }
}

function scheduleDashboardParamReload() {
    updateDashboardParams();
    if (current_workspace_view != 'dashboard' || dashboard_state.mass_editor_active || dashboard_state.queries.length == 0) {
        return;
    }

    clearDashboardParamReloadTimer();
    dashboard_state.param_reload_timer = setTimeout(() => {
        dashboard_state.param_reload_timer = null;
        if (dashboard_state.loading) {
            scheduleDashboardParamReload();
            return;
        }
        void reloadDashboard(false);
    }, 120);
}

function wireDashboardParamAutoApply(input) {
    input.addEventListener('change', scheduleDashboardParamReload);
    input.addEventListener('keydown', event => {
        if (event.key == 'Enter') {
            event.preventDefault();
            input.blur();
            scheduleDashboardParamReload();
        }
    });
}

function createDashboardParamInput(name, value) {
    const wrapper = document.createElement('label');
    wrapper.className = 'dashboard-param';

    const label = document.createElement('span');
    label.textContent = `${name}:`;

    const input = document.createElement('input');
    input.className = 'dashboard-param-input';
    input.name = name;
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;

    const desc = dashboard_default_param_desc[name];
    if (desc?.placeholder) {
        input.placeholder = desc.placeholder;
    }
    if (desc?.title) {
        input.title = desc.title;
    }

    const set_width = () => {
        input.style.width = `${Math.max(5, Math.min(28, input.value.length + 1))}ch`;
    };
    input.addEventListener('input', set_width);
    wireDashboardParamAutoApply(input);
    set_width();

    wrapper.append(label, input);
    return wrapper;
}

function createDashboardRoundingControl() {
    const wrapper = document.createElement('label');
    wrapper.className = 'dashboard-rounding';

    const label = document.createElement('span');
    label.className = 'dashboard-rounding-label';
    label.textContent = 'Bucket';

    const input = document.createElement('input');
    input.className = 'dashboard-param-input';
    input.name = dashboard_rounding_param_name;
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = dashboard_state.params.rounding || dashboard_default_params.rounding;
    input.title = 'Time bucket interval in seconds.';

    const unit = document.createElement('span');
    unit.className = 'dashboard-rounding-unit';
    unit.textContent = 'secs';

    wireDashboardParamAutoApply(input);
    wrapper.append(label, input, unit);
    return wrapper;
}

function createDashboardRangeControls() {
    const range = document.createElement('div');
    range.className = 'dashboard-range';

    const mode = document.createElement('select');
    mode.name = 'dashboard-range-mode';
    const last_option = document.createElement('option');
    last_option.value = 'last';
    last_option.textContent = 'Last';
    const absolute_option = document.createElement('option');
    absolute_option.value = 'absolute';
    absolute_option.textContent = 'Absolute';
    mode.append(last_option, absolute_option);
    mode.value = dashboard_state.params.from || dashboard_state.params.to ? 'absolute' : 'last';

    const last_duration = document.createElement('input');
    last_duration.className = 'dashboard-range-duration';
    last_duration.name = 'dashboard-range-duration';
    last_duration.type = 'number';
    last_duration.min = '1';
    last_duration.step = '1';

    const last_unit = document.createElement('select');
    last_unit.name = 'dashboard-range-unit';
    for (const unit of dashboard_range_units) {
        const option = document.createElement('option');
        option.value = unit.value;
        option.textContent = unit.label;
        last_unit.appendChild(option);
    }

    const duration = splitDashboardDuration(Number(dashboard_state.params.seconds || dashboard_default_params.seconds));
    last_duration.value = String(duration.value);
    last_unit.value = String(duration.unit);

    const absolute = document.createElement('span');
    absolute.className = 'dashboard-range-absolute';

    const from = document.createElement('input');
    from.name = 'dashboard-range-from';
    from.type = 'text';
    from.placeholder = dashboard_default_param_desc.from.placeholder;
    from.title = dashboard_default_param_desc.from.title;
    from.value = dashboard_state.params.from || '';
    from.spellcheck = false;

    const to = document.createElement('input');
    to.name = 'dashboard-range-to';
    to.type = 'text';
    to.placeholder = dashboard_default_param_desc.to.placeholder;
    to.title = dashboard_default_param_desc.to.title;
    to.value = dashboard_state.params.to || '';
    to.spellcheck = false;

    absolute.append(from, to);

    const sync_visible_controls = () => {
        const is_last = mode.value == 'last';
        last_duration.hidden = !is_last;
        last_unit.hidden = !is_last;
        absolute.hidden = is_last;
    };
    mode.addEventListener('change', () => {
        sync_visible_controls();
        scheduleDashboardParamReload();
    });
    for (const input of [last_duration, last_unit, from, to]) {
        wireDashboardParamAutoApply(input);
    }
    sync_visible_controls();

    range.append(mode, last_duration, last_unit, absolute);
    return range;
}

function splitDashboardDuration(seconds) {
    const fallback = Number(dashboard_default_params.seconds);
    const normalized = Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
    for (const unit of [...dashboard_range_units].reverse()) {
        const unit_seconds = Number(unit.value);
        if (normalized >= unit_seconds && normalized % unit_seconds == 0) {
            return { value: normalized / unit_seconds, unit: unit.value };
        }
    }
    return { value: normalized, unit: '1' };
}

function updateDashboardRangeParams() {
    if (!hasDashboardRangeParams()) {
        return;
    }

    const mode = dashboard_params_elem.querySelector('[name="dashboard-range-mode"]')?.value || 'last';
    if (mode == 'absolute') {
        dashboard_state.params.from = dashboard_params_elem.querySelector('[name="dashboard-range-from"]')?.value || '';
        dashboard_state.params.to = dashboard_params_elem.querySelector('[name="dashboard-range-to"]')?.value || '';
        if (!dashboard_state.params.seconds) {
            dashboard_state.params.seconds = dashboard_default_params.seconds;
        }
        return;
    }

    const duration = Number(dashboard_params_elem.querySelector('[name="dashboard-range-duration"]')?.value || 1);
    const unit = Number(dashboard_params_elem.querySelector('[name="dashboard-range-unit"]')?.value || 1);
    const seconds = Math.max(1, Math.round((Number.isFinite(duration) ? duration : 1) * (Number.isFinite(unit) ? unit : 1)));
    dashboard_state.params.seconds = String(seconds);
    dashboard_state.params.from = '';
    dashboard_state.params.to = '';
}

function getDashboardQueryParams() {
    const result = {};
    for (const [name, value] of Object.entries(dashboard_state.params)) {
        result[`param_${name}`] = value;
    }
    return result;
}

function regenerateDashboardCharts() {
    findDashboardParamsInQueries();
    buildDashboardParams();
    destroyDashboardPlots();
    dashboard_charts_elem.innerHTML = '';
    dashboard_state.plots = dashboard_state.queries.map(() => null);

    for (let i = 0; i < dashboard_state.queries.length; i++) {
        insertDashboardChart(i);
    }
}

function insertDashboardChart(index) {
    const query_model = dashboard_state.queries[index];
    const chart = document.createElement('div');
    chart.className = 'dashboard-chart';

    const header = document.createElement('div');
    header.className = 'dashboard-chart-header';

    const title = document.createElement('div');
    title.className = 'dashboard-chart-title';
    title.appendChild(document.createTextNode(''));

    const plot_area = document.createElement('div');
    plot_area.className = 'dashboard-chart-plot';

    const error = document.createElement('div');
    error.className = 'dashboard-chart-error';
    error.appendChild(document.createTextNode(''));

    const editor = document.createElement('div');
    editor.className = 'dashboard-query-editor';

    const title_input = document.createElement('input');
    title_input.type = 'text';
    title_input.value = query_model.title || '';
    title_input.placeholder = 'Chart title';
    title_input.spellcheck = false;

    const query_textarea = document.createElement('textarea');
    query_textarea.value = query_model.query || '';
    query_textarea.placeholder = 'Query';
    query_textarea.spellcheck = false;
    query_textarea.setAttribute('data-gramm', 'false');

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'dashboard-edit-confirm';
    confirm.textContent = 'Ok';

    function getCurrentIndex() {
        return [...dashboard_charts_elem.querySelectorAll('.dashboard-chart')].findIndex(child => child == chart);
    }

    function editStart() {
        editor.classList.add('open');
        query_textarea.focus();
    }

    function editConfirm() {
        const current_index = getCurrentIndex();
        if (current_index < 0) {
            return;
        }
        const current_model = dashboard_state.queries[current_index];
        current_model.title = title_input.value;
        current_model.query = query_textarea.value;
        editor.classList.remove('open');
        error.style.display = 'none';
        findDashboardParamsInQuery(current_model.query, dashboard_state.params);
        buildDashboardParams();
        dashboardRefreshCustomized(true);
        void drawDashboardChart(current_index, chart, current_model.query);
    }

    confirm.addEventListener('click', editConfirm);
    editor.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && (event.keyCode == 13 || event.keyCode == 10)) {
            editConfirm();
        }
        if (event.key == 'Escape') {
            editor.classList.remove('open');
        }
    });
    editor.append(title_input, query_textarea, confirm);

    const buttons = document.createElement('div');
    buttons.className = 'dashboard-chart-buttons';

    const move = createDashboardChartButton('✥', 'Move chart');
    const maximize = createDashboardChartButton('🗖', 'Expand chart height');
    const edit = createDashboardChartButton('✎', 'Edit chart');
    const trash = createDashboardChartButton('✕', 'Delete chart');

    const drag_state = {
        is_dragging: false,
        idx: null,
        offset_x: null,
        offset_y: null,
        displace_idx: null,
        displace_chart: null
    };

    function dragStop() {
        if (!drag_state.is_dragging) {
            return;
        }
        drag_state.is_dragging = false;
        chart.classList.remove('dashboard-chart-moving');
        chart.style.left = '';
        chart.style.top = '';
        chart.style.width = '';
        chart.style.height = '';

        if (drag_state.displace_chart) {
            drag_state.displace_chart.classList.remove('dashboard-chart-displaced');
        }

        if (drag_state.displace_idx !== null) {
            const moved = dashboard_state.queries[drag_state.idx];
            dashboard_state.queries.splice(drag_state.idx, 1);
            dashboard_state.queries.splice(drag_state.displace_idx, 0, moved);
            dashboardRefreshCustomized(true);
            void drawAllDashboardCharts();
        }
    }

    function dragMove(event) {
        if (!drag_state.is_dragging) {
            return;
        }

        chart.style.left = `${event.clientX - drag_state.offset_x}px`;
        chart.style.top = `${event.clientY - drag_state.offset_y}px`;
        drag_state.displace_idx = null;

        if (drag_state.displace_chart) {
            drag_state.displace_chart.classList.remove('dashboard-chart-displaced');
            drag_state.displace_chart = null;
        }

        let current_idx = -1;
        for (const candidate of dashboard_charts_elem.querySelectorAll('.dashboard-chart')) {
            current_idx++;
            if (current_idx == drag_state.idx) {
                continue;
            }

            const chart_rect = chart.getBoundingClientRect();
            const chart_center_x = chart_rect.left + chart_rect.width / 2;
            const chart_center_y = chart_rect.top + chart_rect.height / 2;
            const candidate_rect = candidate.getBoundingClientRect();
            const intersects = chart_center_x >= candidate_rect.left
                && chart_center_x <= candidate_rect.right
                && chart_center_y >= candidate_rect.top
                && chart_center_y <= candidate_rect.bottom;

            candidate.classList.toggle('dashboard-chart-displaced', intersects);
            if (intersects) {
                drag_state.displace_idx = current_idx;
                drag_state.displace_chart = candidate;
            }
        }
    }

    function dragStart(event) {
        if (event.button !== 0) {
            return;
        }

        move.setPointerCapture(event.pointerId);
        const rect = chart.getBoundingClientRect();
        drag_state.is_dragging = true;
        drag_state.idx = getCurrentIndex();
        drag_state.offset_x = event.clientX - rect.left;
        drag_state.offset_y = event.clientY - rect.top;
        chart.classList.add('dashboard-chart-moving');
        chart.style.left = `${rect.left}px`;
        chart.style.top = `${rect.top}px`;
        chart.style.width = `${rect.width}px`;
        chart.style.height = `${rect.height}px`;
    }

    move.addEventListener('pointerdown', dragStart);
    move.addEventListener('pointermove', dragMove);
    move.addEventListener('pointerup', dragStop);
    move.addEventListener('pointercancel', dragStop);
    maximize.addEventListener('click', () => {
        chart.classList.toggle('dashboard-chart-maximized');
        dashboardResizeCharts();
    });
    edit.addEventListener('click', editStart);
    trash.addEventListener('click', () => {
        const current_index = getCurrentIndex();
        if (current_index < 0) {
            return;
        }
        destroyDashboardPlot(current_index);
        dashboard_state.plots.splice(current_index, 1);
        dashboard_state.queries.splice(current_index, 1);
        chart.remove();
        findDashboardParamsInQueries();
        buildDashboardParams();
        dashboardRefreshCustomized(true);
        dashboardResizeCharts();
    });

    chart.addEventListener('mouseenter', () => {
        dashboard_state.active_chart_index = getCurrentIndex();
    });
    chart.addEventListener('focusin', () => {
        dashboard_state.active_chart_index = getCurrentIndex();
    });
    chart.addEventListener('pointerdown', () => {
        dashboard_state.active_chart_index = getCurrentIndex();
    });
    plot_area.addEventListener('dblclick', () => {
        resetDashboardZoom();
    });

    buttons.append(move, maximize, edit, trash);
    header.append(title, buttons);
    chart.append(header, plot_area, error, editor);
    dashboard_charts_elem.appendChild(chart);

    if (!query_model.query) {
        editStart();
    }

    return { chart, textarea: query_textarea };
}

function createDashboardChartButton(text, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
}

function handleDashboardKeyDown(event) {
    if (event.key != 'Escape' || current_workspace_view != 'dashboard') {
        return;
    }
    if (dashboard_state.mass_editor_active || dashboard_charts_elem.querySelector('.dashboard-query-editor.open')) {
        return;
    }

    const active_tag = document.activeElement?.tagName?.toLowerCase() || '';
    if (['input', 'textarea', 'select'].includes(active_tag)) {
        return;
    }

    resetDashboardZoom();
    event.preventDefault();
}

function resetDashboardZoom() {
    for (const plot of dashboard_state.plots) {
        resetDashboardPlotZoom(plot);
    }
}

function resetDashboardPlotZoom(plot) {
    if (!plot?.data) {
        return;
    }

    const x_bounds = getDashboardSeriesBounds(plot.data[0]);
    if (x_bounds) {
        plot.setScale('x', x_bounds);
    }

    const y_values = plot.data.slice(1).flat();
    const y_bounds = getDashboardSeriesBounds(y_values);
    if (y_bounds) {
        plot.setScale('y', y_bounds);
    }
}

function getDashboardSeriesBounds(values) {
    const finite_values = (values || []).filter(value => Number.isFinite(Number(value))).map(Number);
    if (!finite_values.length) {
        return null;
    }

    let min = Math.min(...finite_values);
    let max = Math.max(...finite_values);
    if (min == max) {
        min -= 1;
        max += 1;
    }
    return { min, max };
}

function showDashboardMassEditor() {
    dashboard_charts_elem.hidden = true;
    dashboard_mass_editor_elem.hidden = false;
    dashboard_mass_editor_textarea_elem.value = JSON.stringify({
        params: dashboard_state.params,
        queries: dashboard_state.queries
    }, null, 2);
    dashboard_mass_editor_message_elem.textContent = '';
    dashboard_state.mass_editor_active = true;
    validateDashboardMassEditor();
    dashboard_mass_editor_textarea_elem.focus();
}

function dashboardHideMassEditor() {
    dashboard_mass_editor_elem.hidden = true;
    dashboard_charts_elem.hidden = false;
    dashboard_state.mass_editor_active = false;
}

function validateDashboardMassEditor() {
    dashboard_mass_editor_message_elem.textContent = '';
    if (!dashboard_mass_editor_textarea_elem.value.trim()) {
        dashboard_mass_editor_confirm_elem.disabled = true;
        return false;
    }

    try {
        JSON.parse(dashboard_mass_editor_textarea_elem.value);
        dashboard_mass_editor_confirm_elem.disabled = false;
        return true;
    } catch (e) {
        dashboard_mass_editor_message_elem.textContent = e.toString();
        dashboard_mass_editor_confirm_elem.disabled = true;
        return false;
    }
}

function applyDashboardMassEditorChanges() {
    if (!validateDashboardMassEditor()) {
        return;
    }

    try {
        const next = JSON.parse(dashboard_mass_editor_textarea_elem.value);
        dashboard_state.params = next.params && typeof next.params == 'object' ? next.params : {};
        dashboard_state.queries = Array.isArray(next.queries) ? next.queries.map(query => ({
            title: String(query?.title || ''),
            query: String(query?.query || '')
        })) : [];
        dashboardHideMassEditor();
        regenerateDashboardCharts();
        dashboardRefreshCustomized(true);
        void drawAllDashboardCharts();
    } catch (e) {
        dashboard_mass_editor_message_elem.textContent = e.toString();
    }
}

function destroyDashboardPlot(index) {
    if (dashboard_state.plots[index]) {
        dashboard_state.plots[index].destroy();
        dashboard_state.plots[index] = null;
    }
}

function destroyDashboardPlots() {
    for (let i = 0; i < dashboard_state.plots.length; i++) {
        destroyDashboardPlot(i);
    }
}

async function drawAllDashboardCharts() {
    if (dashboard_state.drawing || current_workspace_view != 'dashboard') {
        return;
    }

    dashboard_state.drawing = true;
    dashboardHideGlobalError();

    try {
        const charts = [...dashboard_charts_elem.querySelectorAll('.dashboard-chart')];
        const query_params = getDashboardQueryParams();
        await Promise.all(charts.map((chart, index) =>
            drawDashboardChart(index, chart, dashboard_state.queries[index]?.query || '', query_params)
        ));
    } catch (e) {
        console.log(e);
        dashboardShowGlobalError(e.message || e.toString());
    } finally {
        dashboard_state.drawing = false;
    }
}

async function drawDashboardChart(index, chart, query, query_params = getDashboardQueryParams()) {
    if (!query) {
        return false;
    }

    destroyDashboardPlot(index);
    const error_div = chart.querySelector('.dashboard-chart-error');
    const title_div = chart.querySelector('.dashboard-chart-title');
    const plot_area = chart.querySelector('.dashboard-chart-plot');
    const query_model = dashboard_state.queries[index] || {};
    title_div.firstChild.data = (query_model.title || '').replaceAll(/\{(\w+)\}/g, (_, name) => dashboard_state.params[name] || '');

    let reply;
    let error = '';
    try {
        reply = await dashboardFetch(query, query_params);
        error = validateDashboardChartReply(reply);
        if (!error && reply.meta.length == 3 && isDashboardStringColumn(reply.meta[1].type)) {
            transformDashboardLabelsToColumns(reply);
            error = validateDashboardChartReply(reply);
        }
    } catch (e) {
        error = e.message || e.toString();
    }

    if (error) {
        error_div.firstChild.data = error;
        error_div.style.display = 'block';
        return false;
    }

    error_div.firstChild.data = '';
    error_div.style.display = 'none';

    await loadUplot();

    const color_rotate = Math.abs(dashboardStringHash(query));
    const line_color = theme != 'dark'
        ? dashboardGenerateColor(0.75, 0.14, (21 + color_rotate) % 360)
        : dashboardGenerateColor(0.53, 0.07, (56 + color_rotate) % 360);
    const fill_color = theme != 'dark'
        ? dashboardGenerateColor(0.96, 0.02, (21 + color_rotate) % 360)
        : dashboardGenerateColor(0.36, 0.07, (56 + color_rotate) % 360);
    const grid_color = theme != 'dark' ? '#eeeedd' : '#2c3235';
    const axes_color = theme != 'dark' ? '#2c3235' : '#c7d0d9';
    const series_count = reply.meta.length;
    const palette = series_count == 2 ? [line_color] : dashboardGeneratePalette(series_count);
    const fill = series_count == 2 ? fill_color : undefined;
    const data = [reply.data[reply.meta[0].name]];
    const series = [{ label: 'time', value: (self, value) => dashboardFormatDateTime(value) }];
    let max_value = Number.NEGATIVE_INFINITY;

    for (let i = 1; i < series_count; i++) {
        const label = reply.meta[i].name;
        series.push({
            label,
            stroke: palette[i - 1],
            fill,
            points: { size: 3, fill: palette[i - 1] }
        });
        data.push(reply.data[label]);
        max_value = Math.max(max_value, ...reply.data[label].filter(value => value !== null && value !== undefined));
    }

    const sync = uPlot.sync('dashboard-sync');
    const opts = {
        width: Math.max(1, plot_area.clientWidth),
        height: Math.max(1, plot_area.clientHeight),
        scales: { x: { time: false } },
        axes: [
            {
                stroke: axes_color,
                grid: { width: 1 / devicePixelRatio, stroke: grid_color },
                ticks: { width: 1 / devicePixelRatio, stroke: grid_color },
                values: dashboardFormatDateTimes,
                space: 80,
                incrs: [1, 5, 10, 15, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400]
            },
            {
                stroke: axes_color,
                grid: { width: 1 / devicePixelRatio, stroke: grid_color },
                ticks: { width: 1 / devicePixelRatio, stroke: grid_color },
                values: (self, ticks) => ticks.map(dashboardFormatValue)
            }
        ],
        series,
        padding: [null, null, null, 3],
        plugins: [legendAsTooltipPlugin({ style: { background: 'var(--element-background-color)' } })],
        cursor: { sync: { key: 'dashboard-sync' } }
    };

    dashboard_state.plots[index] = new uPlot(opts, data, plot_area);
    sync.sub(dashboard_state.plots[index]);
    return true;
}

function validateDashboardChartReply(reply) {
    if (!reply?.rows) {
        return 'Query returned empty result.';
    }
    if (!Array.isArray(reply.meta) || reply.meta.length < 2) {
        return 'Query should return at least two columns: unix timestamp and value.';
    }

    const first_column = getDashboardReplyColumn(reply, reply.meta[0].name);
    for (const column of reply.meta) {
        const values = getDashboardReplyColumn(reply, column.name);
        if (!Array.isArray(values) || values.length != first_column.length) {
            return 'Wrong data format of the query.';
        }
    }
    return '';
}

function isDashboardStringColumn(type) {
    return type == 'String' || type == 'LowCardinality(String)';
}

function transformDashboardLabelsToColumns(reply) {
    const x = reply.meta[0].name;
    const label_column = reply.meta[1].name;
    const y = reply.meta[2].name;
    const labels = [...new Set(reply.data[label_column])].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    if (labels.includes('__time__')) {
        throw new Error("The second column is not allowed to contain '__time__' values.");
    }

    const new_meta = [{ name: '__time__', type: reply.meta[0].type }];
    const new_data = { __time__: [] };
    for (const label of labels) {
        const normalized_label = String(label);
        new_meta.push({ name: normalized_label, type: reply.meta[2].type });
        new_data[normalized_label] = [];
    }

    let row_count = 0;
    const completeRow = row_time => {
        row_count++;
        new_data.__time__.push(row_time);
        for (const label of labels) {
            const normalized_label = String(label);
            if (new_data[normalized_label].length < row_count) {
                new_data[normalized_label].push(null);
            }
        }
    };

    let previous_time = reply.data[x][0];
    for (let i = 0; i < reply.data[x].length; i++) {
        const time = reply.data[x][i];
        const label = String(reply.data[label_column][i]);
        const value = reply.data[y][i];
        if (previous_time != time) {
            completeRow(previous_time);
            previous_time = time;
        }
        new_data[label].push(value);
    }
    completeRow(previous_time);

    reply.meta = new_meta;
    reply.data = new_data;
    reply.rows = row_count;
}

function dashboardResizeCharts() {
    for (const plot of dashboard_state.plots) {
        if (plot) {
            const plot_area = plot.over.closest('.dashboard-chart-plot');
            plot.setSize({ width: Math.max(1, plot_area.clientWidth), height: Math.max(1, plot_area.clientHeight) });
        }
    }
}

function redrawDashboardCharts() {
    if (current_workspace_view == 'dashboard' && dashboard_state.queries.length) {
        void drawAllDashboardCharts();
    }
}

function dashboardFormatDateTime(value) {
    return new Date(value * 1000).toISOString().replace('T', '\n').replace('.000Z', '');
}

function dashboardFormatDateTimes(self, ticks) {
    return ticks.map((tick, index) => {
        const formatted = dashboardFormatDateTime(tick);
        if (index == 0 || formatted.slice(0, 10) != dashboardFormatDateTime(ticks[index - 1]).slice(0, 10)) {
            return formatted;
        }
        return formatted.slice(11);
    });
}

function dashboardFormatValue(value) {
    const abs = Math.abs(value);
    if (abs >= 1000000000000000) return `${value / 1000000000000000}P`;
    if (abs >= 1000000000000) return `${value / 1000000000000}T`;
    if (abs >= 1000000000) return `${value / 1000000000}G`;
    if (abs >= 1000000) return `${value / 1000000}M`;
    if (abs >= 1000) return `${value / 1000}K`;
    if (abs > 0 && abs < 0.001) return `${value * 1000000}u`;
    return value;
}

function dashboardStringHash(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash = hash & hash;
    }
    return hash;
}

function dashboardGenerateColor(l, c, h) {
    const multiplyMatrices = (A, B) => [
        A[0] * B[0] + A[1] * B[1] + A[2] * B[2],
        A[3] * B[0] + A[4] * B[1] + A[5] * B[2],
        A[6] * B[0] + A[7] * B[1] + A[8] * B[2]
    ];
    const oklch2oklab = ([lightness, chroma, hue]) => [
        lightness,
        Number.isNaN(hue) ? 0 : chroma * Math.cos(hue * Math.PI / 180),
        Number.isNaN(hue) ? 0 : chroma * Math.sin(hue * Math.PI / 180)
    ];
    const srgbLinear2rgb = rgb => rgb.map(value =>
        Math.abs(value) > 0.0031308
            ? (value < 0 ? -1 : 1) * (1.055 * (Math.abs(value) ** (1 / 2.4)) - 0.055)
            : 12.92 * value
    );
    const oklab2xyz = lab => {
        const LMSg = multiplyMatrices([
            1, 0.3963377773761749, 0.2158037573099136,
            1, -0.1055613458156586, -0.0638541728258133,
            1, -0.0894841775298119, -1.2914855480194092
        ], lab);
        const LMS = LMSg.map(value => value ** 3);
        return multiplyMatrices([
            1.2268798758459243, -0.5578149944602171, 0.2813910456659647,
            -0.0405757452148008, 1.1122868032803170, -0.0717110580655164,
            -0.0763729366746601, -0.4214933322423, 1.5869240198367816
        ], LMS);
    };
    const xyz2rgbLinear = xyz => multiplyMatrices([
        3.2409699419045226, -1.537383177570094, -0.4986107602930034,
        -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
        0.05563007969699366, -0.20397695888897652, 1.0569715142428786
    ], xyz);
    const rgb = srgbLinear2rgb(xyz2rgbLinear(oklab2xyz(oklch2oklab([l, c, h]))));
    return `rgb(${rgb[0] * 255}, ${rgb[1] * 255}, ${rgb[2] * 255})`;
}

function dashboardGeneratePalette(num_colors) {
    const palette = [];
    for (let i = 0; i < num_colors; i++) {
        palette.push(dashboardGenerateColor(theme != 'dark' ? 0.75 : 0.5, 0.15, 360 * i / num_colors));
    }
    return palette;
}
