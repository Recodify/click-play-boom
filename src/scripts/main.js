
/// Incremental request number. When response is received,
/// if its request number does not equal to the current request number, response will be ignored.
/// This is to avoid race conditions.
let request_num = 0;

/// Save query in history only if it is different.
let previous_query = '';

/// Start of the last query
let last_query_start = 0;

const current_url = new URL(window.location);
const opened_locally = location.protocol == 'file:';

/// Run query instantly after page is loaded if the run parameter is present.
const run_immediately = current_url.searchParams.has("run");

let url_elem = document.getElementById('url');
let user_elem = document.getElementById('user');
let password_elem = document.getElementById('password');
let query_area = document.getElementById('query');
let run_button = document.getElementById('run');
let query_backdrop_elem = document.getElementById('query-backdrop');
let autocomplete_menu_elem = document.getElementById('autocomplete-menu');
let schema_filter_elem = document.getElementById('schema-filter');
let snippet_filter_elem = document.getElementById('snippet-filter');
let snippet_insertion_mode_elem = document.getElementById('snippet-insertion-mode');
let navigator_show_types_elem = document.getElementById('navigator-show-types');
let schema_browser_elem = document.getElementById('schema-browser');
let schema_browser_empty_elem = document.getElementById('schema-browser-empty');
let snippets_browser_elem = document.getElementById('snippets-browser');
let snippets_browser_empty_elem = document.getElementById('snippets-browser-empty');
let navigator_context_menu_elem = document.getElementById('navigator-context-menu');
let connection_editor_elem = document.getElementById('connection-editor');
let connection_editor_title_elem = document.getElementById('connection-editor-title');
let connection_name_input_elem = document.getElementById('connection-name');
let connection_url_input_elem = document.getElementById('connection-url');
let connection_user_input_elem = document.getElementById('connection-user');
let connection_password_input_elem = document.getElementById('connection-password');
let connection_folder_select_elem = document.getElementById('connection-folder');
let connection_editor_save_elem = document.getElementById('connection-editor-save');
let connection_editor_cancel_elem = document.getElementById('connection-editor-cancel');
let schema_compat_editor_elem = document.getElementById('schema-compat-editor');
let schema_compat_editor_title_elem = document.getElementById('schema-compat-editor-title');
let schema_compat_database_elem = document.getElementById('schema-compat-database');
let schema_compat_create_database_elem = document.getElementById('schema-compat-create-database');
let schema_compat_new_database_elem = document.getElementById('schema-compat-new-database');
let schema_compat_editor_message_elem = document.getElementById('schema-compat-editor-message');
let schema_compat_editor_generate_elem = document.getElementById('schema-compat-editor-generate');
let schema_compat_editor_cancel_elem = document.getElementById('schema-compat-editor-cancel');
let active_connection_banner_elem = document.getElementById('active-connection-banner');
let active_connection_name_elem = document.getElementById('active-connection-name');
let active_connection_meta_elem = document.getElementById('active-connection-meta');
let app_view_query_elem = document.getElementById('app-view-query');
let app_view_dashboard_elem = document.getElementById('app-view-dashboard');
let app_view_schema_elem = document.getElementById('app-view-schema');
let navigator_footer_primary_elem = document.getElementById('navigator-footer-primary');
let results_workspace_elem = document.getElementById('results_workspace');
let dashboard_workspace_elem = document.getElementById('dashboard_workspace');
let dashboard_controls_elem = document.getElementById('dashboard-controls');
let dashboard_reload_elem = document.getElementById('dashboard-reload');
let dashboard_reset_zoom_elem = document.getElementById('dashboard-reset-zoom');
let dashboard_add_elem = document.getElementById('dashboard-add');
let dashboard_edit_elem = document.getElementById('dashboard-edit');
let dashboard_search_query_elem = document.getElementById('dashboard-search-query');
let dashboard_search_span_elem = document.getElementById('dashboard-search-span');
let dashboard_params_elem = document.getElementById('dashboard-params');
let dashboard_error_elem = document.getElementById('dashboard-error');
let dashboard_mass_editor_elem = document.getElementById('dashboard-mass-editor');
let dashboard_mass_editor_textarea_elem = document.getElementById('dashboard-mass-editor-textarea');
let dashboard_mass_editor_message_elem = document.getElementById('dashboard-mass-editor-message');
let dashboard_mass_editor_cancel_elem = document.getElementById('dashboard-mass-editor-cancel');
let dashboard_mass_editor_confirm_elem = document.getElementById('dashboard-mass-editor-confirm');
let dashboard_charts_elem = document.getElementById('dashboard-charts');
let schema_workspace_elem = document.getElementById('schema_workspace');
let schema_controls_elem = document.getElementById('schema-controls');
let schema_search_elem = document.getElementById('schema-search');
let schema_db_filter_elem = document.getElementById('schema-db-filter');
let schema_db_filter_button_elem = document.getElementById('schema-db-filter-button');
let schema_db_filter_menu_elem = document.getElementById('schema-db-filter-menu');
let schema_toggle_columns_elem = document.getElementById('schema-toggle-columns');
let schema_toggle_system_elem = document.getElementById('schema-toggle-system');
let schema_load_period_elem = document.getElementById('schema-load-period');
let schema_load_metric_elem = document.getElementById('schema-load-metric');
let schema_relayout_elem = document.getElementById('schema-relayout');
let schema_reload_elem = document.getElementById('schema-reload');
let schema_status_elem = document.getElementById('schema-status');
let schema_load_legend_elem = document.getElementById('schema-load-legend');
let schema_load_legend_label_elem = document.getElementById('schema-load-legend-label');
let schema_viewport_elem = document.getElementById('schema-viewport');
let schema_canvas_elem = document.getElementById('schema-canvas');
let schema_links_svg_elem = document.getElementById('schema-links-svg');
let schema_empty_elem = document.getElementById('schema-empty');
let schema_sidebar_elem = document.getElementById('schema-sidebar');
let schema_sidebar_title_elem = document.getElementById('schema-sidebar-title');
let schema_sidebar_content_elem = document.getElementById('schema-sidebar-content');
let schema_sidebar_close_elem = document.getElementById('schema-sidebar-close');
let schema_zoom_out_elem = document.getElementById('schema-zoom-out');
let schema_zoom_reset_elem = document.getElementById('schema-zoom-reset');
let schema_zoom_in_elem = document.getElementById('schema-zoom-in');
let results_header_elem = document.getElementById('results_header');
let results_tabs_elem = document.getElementById('results_tabs');
let results_panels_elem = document.getElementById('results_panels');
let action_history_empty_elem = document.getElementById('action-history-empty');
let action_body = document.getElementById('action_body');
let download_use_cache_elem = document.getElementById('download-use-cache');
let refresh_schema_elem = document.getElementById('refresh-schema');
let new_connection_folder_elem = document.getElementById('new-connection-folder');
let new_snippet_folder_elem = document.getElementById('new-snippet-folder');
let save_query_snippet_elem = document.getElementById('save-query-snippet');
let export_snippets_elem = document.getElementById('export-snippets');
let import_snippets_elem = document.getElementById('import-snippets');
let import_snippets_file_elem = document.getElementById('import-snippets-file');
let toggle_editor_elem = document.getElementById('toggle-editor');
let abort_preview_limit_elem = document.getElementById('abort-preview-limit');
let databases_elem = document.getElementById('databases');
let menu_elem = document.getElementById('menu');
let sidebar_resizer_elem = document.getElementById('sidebar-resizer');

const storage_schema_version = 2;
const saved_connections_key = 'play-recodified.connections.v2';
const active_connection_key = 'play-recodified.active-connection.v2';
const download_query_cache_key = 'play-reborn.download-query-cache.v1';
const navigator_state_key = 'play-reborn.navigator-state.v1';
const sidebar_collapsed_key = 'play-reborn.sidebar-collapsed.v1';
const navigator_show_types_key = 'play-reborn.navigator-show-types.v1';
const abort_preview_limit_key = 'play-reborn.abort-preview-limit.v1';
const sidebar_width_key = 'play-reborn.sidebar-width.v1';
const query_editor_compact_key = 'play-reborn.query-editor-compact.v1';
const sidebar_active_tab_key = 'play-reborn.sidebar-active-tab.v1';
const query_snippets_key = 'play-reborn.query-snippets.v2';
const snippet_insertion_mode_key = 'play-reborn.snippet-insertion-mode.v1';

let action_history = [];
let result_history = [];
let active_result_id = null;
let current_workspace_view = ['dashboard', 'schema'].includes(current_url.searchParams.get('view')) ? current_url.searchParams.get('view') : 'query';
let current_result_elements = null;
let current_result_meta = null;
let render_result_elements = null;
let render_result_meta = null;
let current_connection_id = null;
let current_connection_name = 'default';
let connection_editor_state = null;
let schema_compat_editor_state = null;
let stop_after_current = false;
let query_editor_expanded_height = '';
let query_snippets_state = loadQuerySnippets();
const large_editor_insert_threshold = 12000;
const large_editor_highlight_delay_ms = 120;
let query_highlight_timeout = null;
let suppress_programmatic_query_input = false;
const insertion_manager = {
    last_selection_start: 0,
    last_selection_end: 0,
    snippet_mode: 'append'
};
const autocomplete_suggestion_limit = 80;
let autocomplete_caret_mirror_elem = null;
let autocomplete_table_loads = {};
let autocomplete_column_loads = {};
let autocomplete_schema_revision = 0;
let autocomplete_state = {
    open: false,
    replace_start: 0,
    items: [],
    all_items: [],
    active_index: 0,
    prefix: '',
    loading: false,
    statement_key: '',
    schema_revision: 0
};
const query_log_poll_timeout_ms = 120000;
const query_log_poll_fast_window_ms = 10000;
let schema_state = {
    loading: false,
    connection_id: null,
    databases: [],
    tables: {},
    columns: {},
    loading_tables: {},
    table_messages: {},
    message: 'Loading navigator...'
};
let navigator_state = loadNavigatorState();

function getRenderResultElements() { return render_result_elements || current_result_elements; }
function getRenderResultMeta() { return render_result_meta || current_result_meta; }
function isRenderResultActive() { return getRenderResultMeta()?.id == active_result_id; }
function getCurrentDataTable() { return getRenderResultElements()?.data_table || null; }
function getCurrentDataDiv() { return getRenderResultElements()?.data_div || null; }
function getCurrentDataUnparsed() { return getRenderResultElements()?.data_unparsed || null; }
function getCurrentChart() { return getRenderResultElements()?.chart || null; }
function getCurrentGraph() { return getRenderResultElements()?.graph || null; }
function getCurrentError() { return getRenderResultElements()?.error || null; }
function getCurrentTbody() { return getCurrentDataTable()?.querySelector('tbody') || null; }
function shouldUseQueryCacheForDownload() { return !!download_use_cache_elem?.checked; }
function shouldShowNavigatorTypes() { return !!navigator_show_types_elem?.checked; }
function shouldAbortAtPreviewLimit() { return !!abort_preview_limit_elem?.checked; }

function buildClickHouseUrl(server_address, user, password, default_format = 'JSON', extra_params = {}) {
    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?');
    const params = {
        add_http_cors_header: '1',
        default_format: default_format,
        ...extra_params
    };

    if (user) {
        params.user = user;
    }
    if (password) {
        params.password = password;
    }

    return url + Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

function setDownloadQueryCachePreference(enabled, persist = true) {
    download_use_cache_elem.checked = enabled;
    if (persist) {
        window.localStorage.setItem(download_query_cache_key, enabled ? '1' : '0');
    }
}

function setNavigatorTypesVisible(enabled, persist = true) {
    navigator_show_types_elem.checked = enabled;
    databases_elem.classList.toggle('show-types', enabled);
    if (persist) {
        window.localStorage.setItem(navigator_show_types_key, enabled ? '1' : '0');
    }
}

function setAbortPreviewLimit(enabled, persist = true) {
    abort_preview_limit_elem.checked = enabled;
    if (persist) {
        window.localStorage.setItem(abort_preview_limit_key, enabled ? '1' : '0');
    }
}

function setSidebarWidth(width, persist = true) {
    const bounded_width = Math.max(280, Math.min(720, Math.round(width)));
    document.body.style.setProperty('--sidebar-width', `${bounded_width}px`);
    if (persist) {
        window.localStorage.setItem(sidebar_width_key, String(bounded_width));
    }
}

if (url_elem.value == '') {
    const server_address = current_url.searchParams.get('url');
    if (server_address) {
        url_elem.value = server_address;
    } else if (!opened_locally) {
        /// Substitute the address of the server where the page is served.
        url_elem.value = location.origin;
    } else {
        url_elem.value = 'http://localhost:8123/';
    }
}

/// Substitute username if it's specified in the query string
const user_from_url = current_url.searchParams.get('user');
if (user_from_url) {
    user_elem.value = user_from_url;
}

const pass_from_url = current_url.searchParams.get('password');
if (pass_from_url) {
    password_elem.value = pass_from_url;
    /// Browsers don't allow manipulating history for the 'file:' protocol.
    if (!opened_locally) {
        let replaced_pass = current_url.searchParams;
        replaced_pass.delete('password');
        window.history.replaceState(null, '',
            window.location.origin + window.location.pathname + '?'
            + replaced_pass.toString() + window.location.hash);
    }
}
