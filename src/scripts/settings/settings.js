const settings_session_timeout_seconds = 1800;
const clickhouse_setting_identifier_pattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved_query_default_names = new Set([
    'add_http_cors_header',
    'default_format',
    'enable_http_compression',
    'password',
    'query_id',
    'session_check',
    'session_id',
    'session_timeout',
    'user'
]);

const settings_connection_name_elem = document.getElementById('settings-connection-name');
const settings_catalog_status_elem = document.getElementById('settings-catalog-status');
const settings_catalog_refresh_elem = document.getElementById('settings-catalog-refresh');
const settings_catalog_combobox_elem = document.getElementById('settings-catalog-combobox');
const settings_theme_elem = document.getElementById('settings-theme');
const settings_snippet_mode_elem = document.getElementById('settings-snippet-mode');
const settings_abort_preview_elem = document.getElementById('settings-abort-preview');
const settings_query_cache_elem = document.getElementById('settings-query-cache');
const settings_navigator_types_elem = document.getElementById('settings-navigator-types');
const settings_compact_editor_elem = document.getElementById('settings-compact-editor');
const settings_preferences_message_elem = document.getElementById('settings-preferences-message');
const settings_session_status_elem = document.getElementById('settings-session-status');
const settings_session_connection_elem = document.getElementById('settings-session-connection');
const settings_session_rows_elem = document.getElementById('settings-session-rows');
const settings_session_add_elem = document.getElementById('settings-session-add');
const settings_session_restart_elem = document.getElementById('settings-session-restart');
const settings_session_apply_elem = document.getElementById('settings-session-apply');
const settings_session_message_elem = document.getElementById('settings-session-message');
const settings_query_default_scope_elem = document.getElementById('settings-query-default-scope');
const settings_query_default_filter_elem = document.getElementById('settings-query-default-filter');
const settings_query_default_rows_elem = document.getElementById('settings-query-default-rows');
const settings_query_default_add_elem = document.getElementById('settings-query-default-add');
const settings_query_default_test_elem = document.getElementById('settings-query-default-test');
const settings_query_default_save_elem = document.getElementById('settings-query-default-save');
const settings_query_default_message_elem = document.getElementById('settings-query-default-message');

const settings_catalog_cache = new Map();
const settings_query_default_drafts = new Map();
const settings_catalog_combobox_option_height = 58;
const settings_catalog_combobox_overscan = 3;
let settings_active_catalog = null;
let settings_session_store = loadSessionSettingsStoreForDocument();
let settings_session_draft = { connection_id: '', rows: [] };
let settings_initialized = false;
let settings_catalog_combobox_state = {
    input: null,
    callbacks: null,
    results: [],
    active_index: -1,
    surface: null,
    rendered_start: -1,
    rendered_end: -1,
    rendered_active_index: -1
};

class ClickHouseSessionError extends Error {
    constructor(message, code = 0) {
        super(message);
        this.name = 'ClickHouseSessionError';
        this.code = Number(code || 0);
    }
}

function isSelectableSettingsCatalogEntry(setting) {
    return !setting.readonly && !setting.is_obsolete && !isReservedQueryDefaultName(setting.name);
}

function getSettingsCatalogMatchScore(setting, raw_query) {
    const query = raw_query.trim().toLowerCase();
    if (!query) {
        return 50;
    }

    const name = setting.search_name;
    const type = setting.search_type;
    const description = setting.search_description;
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.every(term => setting.search_text.includes(term))) {
        return Number.POSITIVE_INFINITY;
    }
    if (name == query) {
        return 0;
    }
    if (name.startsWith(query)) {
        return 1;
    }
    if (setting.search_name_parts.some(part => part.startsWith(query))) {
        return 2;
    }
    if (name.includes(query)) {
        return 3;
    }
    if (type == query) {
        return 4;
    }
    if (type.includes(query)) {
        return 5;
    }
    if (description.includes(query)) {
        return 6;
    }
    return 7;
}

function findSettingsCatalogMatches(query) {
    return (settings_active_catalog?.rows || [])
        .filter(isSelectableSettingsCatalogEntry)
        .map(setting => ({ setting, score: getSettingsCatalogMatchScore(setting, query) }))
        .filter(entry => Number.isFinite(entry.score))
        .sort((a, b) => a.score - b.score || a.setting.name.localeCompare(b.setting.name))
        .map(entry => entry.setting);
}

function positionSettingsCatalogCombobox() {
    const input = settings_catalog_combobox_state.input;
    if (!input || !input.isConnected || settings_catalog_combobox_elem.hidden) {
        return;
    }

    const input_rect = input.getBoundingClientRect();
    if (!input_rect.width || !input_rect.height) {
        closeSettingsCatalogCombobox('workspace');
        return;
    }

    const viewport_margin = 8;
    const popup_gap = 4;
    const viewport_width = document.documentElement.clientWidth;
    const viewport_height = document.documentElement.clientHeight;
    const width = Math.min(Math.max(input_rect.width, 320), Math.min(640, viewport_width - 2 * viewport_margin));
    const left = Math.max(viewport_margin, Math.min(input_rect.left, viewport_width - width - viewport_margin));
    const space_below = Math.max(0, viewport_height - input_rect.bottom - popup_gap - viewport_margin);
    const space_above = Math.max(0, input_rect.top - popup_gap - viewport_margin);
    const desired_height = Math.min(settings_catalog_combobox_elem.scrollHeight, 320);
    const place_below = space_below >= Math.min(desired_height, 180) || space_below >= space_above;
    const available_height = place_below ? space_below : space_above;
    const max_height = Math.max(48, Math.min(320, available_height));

    settings_catalog_combobox_elem.style.width = `${width}px`;
    settings_catalog_combobox_elem.style.maxHeight = `${max_height}px`;
    const popup_height = Math.min(settings_catalog_combobox_elem.scrollHeight, max_height);
    const requested_top = place_below
        ? input_rect.bottom + popup_gap
        : input_rect.top - popup_gap - popup_height;
    const top = Math.max(viewport_margin, Math.min(requested_top, viewport_height - popup_height - viewport_margin));
    settings_catalog_combobox_elem.style.left = `${left}px`;
    settings_catalog_combobox_elem.style.top = `${top}px`;
    settings_catalog_combobox_elem.dataset.placement = place_below ? 'below' : 'above';
    renderSettingsCatalogComboboxVirtualWindow();
}

function createSettingsCatalogComboboxOption(index, setting) {
    const active = index == settings_catalog_combobox_state.active_index;
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `settings-catalog-option-${index}`;
    option.className = `settings-catalog-option${active ? ' active' : ''}`;
    option.style.top = `${index * settings_catalog_combobox_option_height}px`;
    option.style.height = `${settings_catalog_combobox_option_height}px`;
    option.dataset.resultIndex = String(index);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-posinset', String(index + 1));
    option.setAttribute('aria-setsize', String(settings_catalog_combobox_state.results.length));
    option.setAttribute('aria-selected', active ? 'true' : 'false');
    option.tabIndex = -1;

    const name = document.createElement('span');
    name.className = 'settings-catalog-option-name';
    name.textContent = setting.name;
    name.title = setting.name;
    const type = document.createElement('span');
    type.className = 'settings-catalog-option-type';
    type.textContent = setting.type;
    type.title = setting.type;
    const description = document.createElement('span');
    description.className = 'settings-catalog-option-description';
    description.textContent = setting.description || 'No description available.';
    description.title = setting.description || 'No description available.';
    option.append(name, type, description);
    option.addEventListener('pointermove', () => updateSettingsCatalogComboboxActiveOption(index, false));
    option.addEventListener('pointerdown', event => {
        event.preventDefault();
        chooseSettingsCatalogComboboxOption(index);
    });
    return option;
}

function renderSettingsCatalogComboboxVirtualWindow(force = false) {
    const state = settings_catalog_combobox_state;
    if (!state.input || !state.surface || !state.results.length || settings_catalog_combobox_elem.hidden) {
        return;
    }

    const viewport_height = settings_catalog_combobox_elem.clientHeight;
    if (!viewport_height) {
        return;
    }
    const first_visible = Math.floor(settings_catalog_combobox_elem.scrollTop / settings_catalog_combobox_option_height);
    const visible_count = Math.ceil(viewport_height / settings_catalog_combobox_option_height);
    const start = Math.max(0, first_visible - settings_catalog_combobox_overscan);
    const end = Math.min(state.results.length,
        first_visible + visible_count + settings_catalog_combobox_overscan);
    if (!force
        && start == state.rendered_start
        && end == state.rendered_end
        && state.active_index == state.rendered_active_index) {
        return;
    }

    const indexes = [];
    for (let index = start; index < end; ++index) {
        indexes.push(index);
    }
    if (state.active_index >= 0 && (state.active_index < start || state.active_index >= end)) {
        indexes.push(state.active_index);
        indexes.sort((a, b) => a - b);
    }

    const fragment = document.createDocumentFragment();
    for (const index of indexes) {
        fragment.appendChild(createSettingsCatalogComboboxOption(index, state.results[index]));
    }
    state.surface.replaceChildren(fragment);
    state.rendered_start = start;
    state.rendered_end = end;
    state.rendered_active_index = state.active_index;
    state.input.setAttribute('aria-activedescendant', `settings-catalog-option-${state.active_index}`);
}

function syncSettingsCatalogComboboxRenderedOptions() {
    const state = settings_catalog_combobox_state;
    for (const option of settings_catalog_combobox_elem.querySelectorAll('[role="option"]')) {
        const index = Number(option.dataset.resultIndex);
        const active = index == state.active_index;
        option.classList.toggle('active', active);
        option.setAttribute('aria-selected', active ? 'true' : 'false');
        if (!active && (index < state.rendered_start || index >= state.rendered_end)) {
            option.remove();
        }
    }
    state.rendered_active_index = state.active_index;
    state.input?.setAttribute('aria-activedescendant', `settings-catalog-option-${state.active_index}`);
}

function updateSettingsCatalogComboboxActiveOption(next_index, ensure_visible = true) {
    const state = settings_catalog_combobox_state;
    if (!state.input || !state.results.length) {
        return;
    }
    const active_index = Math.max(0, Math.min(next_index, state.results.length - 1));
    state.active_index = active_index;
    if (!ensure_visible) {
        syncSettingsCatalogComboboxRenderedOptions();
        return;
    }
    const option_top = active_index * settings_catalog_combobox_option_height;
    const option_bottom = option_top + settings_catalog_combobox_option_height;
    const viewport_top = settings_catalog_combobox_elem.scrollTop;
    const viewport_bottom = viewport_top + settings_catalog_combobox_elem.clientHeight;
    let next_scroll_top = viewport_top;
    if (option_top < viewport_top) {
        next_scroll_top = option_top;
    } else if (option_bottom > viewport_bottom) {
        next_scroll_top = option_bottom - settings_catalog_combobox_elem.clientHeight;
    }
    if (next_scroll_top != viewport_top) {
        settings_catalog_combobox_elem.scrollTop = next_scroll_top;
        renderSettingsCatalogComboboxVirtualWindow(true);
    } else if (state.surface.querySelector(`[data-result-index="${active_index}"]`)) {
        syncSettingsCatalogComboboxRenderedOptions();
    } else {
        renderSettingsCatalogComboboxVirtualWindow(true);
    }
}

function chooseSettingsCatalogComboboxOption(index) {
    const { input, callbacks, results } = settings_catalog_combobox_state;
    const setting = results[index];
    if (!input || !setting) {
        return;
    }
    input.value = setting.name;
    callbacks?.onSelect?.(setting);
    closeSettingsCatalogCombobox('select');
    input.focus();
}

function renderSettingsCatalogCombobox() {
    const input = settings_catalog_combobox_state.input;
    if (!input) {
        return;
    }
    const results = findSettingsCatalogMatches(input.value);
    settings_catalog_combobox_state.results = results;
    settings_catalog_combobox_state.active_index = results.length ? 0 : -1;
    settings_catalog_combobox_state.surface = null;
    settings_catalog_combobox_state.rendered_start = -1;
    settings_catalog_combobox_state.rendered_end = -1;
    settings_catalog_combobox_state.rendered_active_index = -1;
    settings_catalog_combobox_elem.replaceChildren();
    settings_catalog_combobox_elem.scrollTop = 0;

    if (!results.length) {
        const empty = document.createElement('div');
        empty.className = 'settings-catalog-combobox-empty';
        empty.textContent = settings_active_catalog ? 'No matching settings.' : 'Setting catalog not loaded.';
        settings_catalog_combobox_elem.appendChild(empty);
        input.removeAttribute('aria-activedescendant');
    } else {
        const surface = document.createElement('div');
        surface.className = 'settings-catalog-virtual-surface';
        surface.style.height = `${results.length * settings_catalog_combobox_option_height}px`;
        settings_catalog_combobox_state.surface = surface;
        settings_catalog_combobox_elem.appendChild(surface);
    }

    settings_catalog_combobox_elem.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    positionSettingsCatalogCombobox();
}

function openSettingsCatalogCombobox(input, callbacks) {
    if (input.disabled) {
        return;
    }
    if (settings_catalog_combobox_state.input && settings_catalog_combobox_state.input != input) {
        closeSettingsCatalogCombobox('switch');
    }
    settings_catalog_combobox_state.input = input;
    settings_catalog_combobox_state.callbacks = callbacks;
    callbacks?.onOpen?.();
    renderSettingsCatalogCombobox();
}

function closeSettingsCatalogCombobox(reason = '') {
    const { input, callbacks } = settings_catalog_combobox_state;
    if (!input) {
        return;
    }
    settings_catalog_combobox_elem.hidden = true;
    settings_catalog_combobox_elem.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    settings_catalog_combobox_state = {
        input: null,
        callbacks: null,
        results: [],
        active_index: -1,
        surface: null,
        rendered_start: -1,
        rendered_end: -1,
        rendered_active_index: -1
    };
    if (reason == 'blur' || reason == 'tab') {
        callbacks?.onBlur?.();
    }
}

function handleSettingsCatalogComboboxKeyDown(event) {
    const state = settings_catalog_combobox_state;
    if (state.input != event.currentTarget) {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            openSettingsCatalogCombobox(event.currentTarget, event.currentTarget.settings_catalog_callbacks);
            if (event.key == 'ArrowUp' && settings_catalog_combobox_state.results.length) {
                updateSettingsCatalogComboboxActiveOption(settings_catalog_combobox_state.results.length - 1);
            }
        }
        return;
    }

    if (event.key == 'ArrowDown' || event.key == 'ArrowUp') {
        event.preventDefault();
        if (state.results.length) {
            const direction = event.key == 'ArrowDown' ? 1 : -1;
            updateSettingsCatalogComboboxActiveOption(
                (state.active_index + direction + state.results.length) % state.results.length);
        }
    } else if (event.key == 'Home' && state.results.length) {
        event.preventDefault();
        updateSettingsCatalogComboboxActiveOption(0);
    } else if (event.key == 'End' && state.results.length) {
        event.preventDefault();
        updateSettingsCatalogComboboxActiveOption(state.results.length - 1);
    } else if (event.key == 'Enter' && state.active_index >= 0) {
        event.preventDefault();
        chooseSettingsCatalogComboboxOption(state.active_index);
    } else if (event.key == 'Escape') {
        event.preventDefault();
        closeSettingsCatalogCombobox('escape');
    } else if (event.key == 'Tab') {
        closeSettingsCatalogCombobox('tab');
    }
}

function registerSettingsCatalogComboboxInput(input, callbacks) {
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', 'settings-catalog-combobox');
    input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';
    input.settings_catalog_callbacks = callbacks;
    input.addEventListener('focus', () => openSettingsCatalogCombobox(input, callbacks));
    input.addEventListener('input', () => {
        if (settings_catalog_combobox_state.input != input) {
            openSettingsCatalogCombobox(input, callbacks);
        } else {
            renderSettingsCatalogCombobox();
        }
    });
    input.addEventListener('keydown', handleSettingsCatalogComboboxKeyDown);
    input.addEventListener('blur', () => {
        if (settings_catalog_combobox_state.input == input) {
            closeSettingsCatalogCombobox('blur');
        } else {
            callbacks?.onBlur?.();
        }
    });
}

function createTransportSessionId() {
    return `click-play-boom-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function emptySessionSettingsStore() {
    return { schema_version: 1, connections: {} };
}

function normalizeSessionManagedSettings(managed) {
    const result = {};
    for (const [name, value] of Object.entries(managed || {})) {
        if (clickhouse_setting_identifier_pattern.test(name) && !isReservedQueryDefaultName(name)) {
            result[name] = String(value ?? '');
        }
    }
    return result;
}

function loadSessionSettingsStoreForDocument() {
    let store = emptySessionSettingsStore();
    try {
        const parsed = JSON.parse(window.sessionStorage.getItem(session_settings_key) || 'null');
        if (parsed?.schema_version == 1 && parsed.connections && typeof parsed.connections == 'object') {
            store = parsed;
        }
    } catch (e) {
        store = emptySessionSettingsStore();
    }

    const connections = {};
    for (const [connection_id, raw_record] of Object.entries(store.connections || {})) {
        if (!connection_id) {
            continue;
        }
        connections[connection_id] = {
            managed: normalizeSessionManagedSettings(raw_record?.managed),
            transport_id: '',
            applied_names: [],
            active: false,
            status: 'not-started',
            message: '',
            connection_revision: String(raw_record?.connection_revision || '')
        };
    }

    const rotated_store = { schema_version: 1, connections };
    try {
        window.sessionStorage.setItem(session_settings_key, JSON.stringify(rotated_store));
    } catch (e) {
        // Session support still works in memory when storage is unavailable.
    }
    return rotated_store;
}

function persistSessionSettingsStore() {
    try {
        window.sessionStorage.setItem(session_settings_key, JSON.stringify(settings_session_store));
    } catch (e) {
        // Keep the current document functional when storage is unavailable.
    }
}

function getCurrentSettingsConnection() {
    return {
        id: current_connection_id || '__current__',
        name: current_connection_name || 'Connection',
        url: url_elem.value || 'http://localhost:8123/',
        user: user_elem.value || 'default',
        password: password_elem.value || '',
        revision: String(getSavedConnections().find(connection => connection.id == current_connection_id)?.updated_at || '')
    };
}

function getSessionRecord(create = true) {
    const connection = getCurrentSettingsConnection();
    let record = settings_session_store.connections[connection.id];
    if (!record && create) {
        record = {
            managed: {},
            transport_id: '',
            applied_names: [],
            active: false,
            status: 'not-started',
            message: '',
            connection_revision: connection.revision
        };
        settings_session_store.connections[connection.id] = record;
        persistSessionSettingsStore();
    }
    return record || null;
}

function setSettingsMessage(element, message = '', kind = '') {
    if (!element) {
        return;
    }
    element.textContent = message;
    element.classList.toggle('error', kind == 'error');
    element.classList.toggle('success', kind == 'success');
}

function renderSessionStatus() {
    const record = getSessionRecord(false);
    const status = record?.status || 'not-started';
    const labels = {
        'not-started': 'Not started',
        active: 'Active',
        recovering: 'Recovering',
        busy: 'Busy',
        error: 'Error'
    };
    settings_session_status_elem.textContent = labels[status] || 'Not started';
    settings_session_status_elem.className = `settings-status-badge ${status}`;
    if (record?.message) {
        setSettingsMessage(settings_session_message_elem, record.message, status == 'error' || status == 'busy' ? 'error' : '');
    }
    updateSessionSettingsBusyState();
}

function isReservedQueryDefaultName(name) {
    const normalized_name = String(name || '').toLowerCase();
    return reserved_query_default_names.has(normalized_name) || normalized_name.startsWith('param_');
}

function getCatalogIdentity(connection) {
    return JSON.stringify([connection.url, connection.user, connection.password]);
}

function normalizeSettingsCatalogRow(row) {
    const name = String(row?.name || '');
    const type = String(row?.type || '');
    const description = String(row?.description || '');
    const search_name = name.toLowerCase();
    const search_type = type.toLowerCase();
    const search_description = description.toLowerCase();
    return {
        name,
        value: String(row?.value ?? ''),
        default: String(row?.default ?? ''),
        description,
        type,
        min: row?.min === null || row?.min === undefined ? '' : String(row.min),
        max: row?.max === null || row?.max === undefined ? '' : String(row.max),
        disallowed_values: Array.isArray(row?.disallowed_values) ? row.disallowed_values.map(String) : [],
        readonly: Number(row?.readonly || 0) != 0,
        alias_for: String(row?.alias_for || ''),
        is_obsolete: Number(row?.is_obsolete || 0) != 0,
        tier: String(row?.tier || ''),
        search_name,
        search_name_parts: search_name.split('_'),
        search_type,
        search_description,
        search_text: `${search_name} ${search_type} ${search_description}`
    };
}

async function loadSettingsCatalog(force = false) {
    const connection = getCurrentSettingsConnection();
    const identity = getCatalogIdentity(connection);
    const cached = settings_catalog_cache.get(connection.id);
    if (!force && cached?.identity == identity && cached.catalog) {
        settings_active_catalog = cached.catalog;
        renderSettingsCatalog();
        return cached.catalog;
    }
    if (!force && cached?.identity == identity && cached.promise) {
        return cached.promise;
    }

    settings_catalog_status_elem.textContent = 'Loading setting catalog…';
    settings_catalog_refresh_elem.disabled = true;
    const promise = (async () => {
        const url = buildClickHouseUrl(connection.url, connection.user, connection.password, 'JSONEachRow');
        const response = await fetch(url, {
            method: 'POST',
            body: `SELECT
    name,
    value,
    default,
    description,
    type,
    min,
    max,
    disallowed_values,
    readonly,
    alias_for,
    is_obsolete,
    toString(tier) AS tier
FROM system.settings
ORDER BY name`
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(text || `Setting catalog request failed (${response.status}).`);
        }

        const rows = text.split('\n')
            .filter(line => line.trim())
            .map(line => normalizeSettingsCatalogRow(JSON.parse(line)))
            .filter(row => row.name);
        const catalog = { rows, by_name: new Map(rows.map(row => [row.name, row])) };
        settings_catalog_cache.set(connection.id, { identity, catalog, promise: null });
        if (getCurrentSettingsConnection().id == connection.id && getCatalogIdentity(getCurrentSettingsConnection()) == identity) {
            settings_active_catalog = catalog;
            renderSettingsCatalog();
        }
        return catalog;
    })();
    settings_catalog_cache.set(connection.id, { identity, catalog: null, promise });

    try {
        return await promise;
    } catch (error) {
        const latest = settings_catalog_cache.get(connection.id);
        if (latest?.identity == identity) {
            settings_catalog_cache.delete(connection.id);
        }
        if (getCurrentSettingsConnection().id == connection.id) {
            settings_active_catalog = null;
            settings_catalog_status_elem.textContent = 'Setting catalog unavailable';
            setSettingsMessage(settings_query_default_message_elem, error.message, 'error');
        }
        throw error;
    } finally {
        settings_catalog_refresh_elem.disabled = false;
    }
}

function renderSettingsCatalog() {
    const rows = settings_active_catalog?.rows || [];
    settings_catalog_status_elem.textContent = settings_active_catalog
        ? `${rows.length.toLocaleString()} settings loaded`
        : 'Setting catalog not loaded';
    renderSessionSettingsEditor();
    renderQueryDefaultsEditor();
}

function getSettingCatalogEntry(name) {
    return settings_active_catalog?.by_name.get(String(name || '').trim()) || null;
}

function formatSettingHelp(setting) {
    if (!setting) {
        return '';
    }
    const details = [setting.type, `default ${setting.default}`];
    if (setting.min || setting.max) {
        details.push(`range ${setting.min || '−∞'}…${setting.max || '∞'}`);
    }
    if (setting.disallowed_values.length) {
        details.push(`disallows ${setting.disallowed_values.join(', ')}`);
    }
    if (setting.tier) {
        details.push(setting.tier);
    }
    if (setting.alias_for) {
        details.push(`alias for ${setting.alias_for}`);
    }
    return `${details.join(' · ')}${setting.description ? ` — ${setting.description}` : ''}`;
}

function validateSettingRow(row, options = {}) {
    const name = String(row?.name || '').trim();
    const mode = row?.mode == 'suppress' ? 'suppress' : 'set';
    if (!name) {
        return 'Choose a setting.';
    }
    if (!clickhouse_setting_identifier_pattern.test(name)) {
        return 'Setting name is not a valid ClickHouse identifier.';
    }
    if (isReservedQueryDefaultName(name)) {
        return 'This HTTP protocol parameter is managed by the application.';
    }
    if (mode == 'suppress' && options.allow_suppress) {
        return '';
    }
    if (!settings_active_catalog) {
        return 'Load the active connection setting catalog first.';
    }
    const setting = getSettingCatalogEntry(name);
    if (!setting) {
        return options.allow_unavailable ? '' : 'Setting is unavailable on the active connection.';
    }
    if (setting.readonly) {
        return 'Setting is readonly for the active connection.';
    }
    if (setting.is_obsolete) {
        return 'Setting is obsolete on the active connection.';
    }
    const value = String(row?.value ?? '');
    if (setting.disallowed_values.includes(value)) {
        return 'Value is disallowed by the active connection.';
    }
    const numeric_value = Number(value);
    const numeric_min = Number(setting.min);
    const numeric_max = Number(setting.max);
    if (value !== '' && Number.isFinite(numeric_value)) {
        if (setting.min !== '' && Number.isFinite(numeric_min) && numeric_value < numeric_min) {
            return `Value is below the minimum ${setting.min}.`;
        }
        if (setting.max !== '' && Number.isFinite(numeric_max) && numeric_value > numeric_max) {
            return `Value is above the maximum ${setting.max}.`;
        }
    }
    return '';
}

function createSettingsEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'settings-empty';
    empty.textContent = message;
    return empty;
}

function getStoredThemePreference() {
    const stored = window.localStorage.getItem(theme_key);
    return ['dark', 'light'].includes(stored) ? stored : 'system';
}

function applyThemePreference(preference) {
    const normalized = ['dark', 'light'].includes(preference) ? preference : 'system';
    if (normalized == 'system') {
        window.localStorage.removeItem(theme_key);
    } else {
        window.localStorage.setItem(theme_key, normalized);
    }

    if (!['dark', 'light'].includes(current_url.searchParams.get('theme'))) {
        const next_theme = normalized == 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : normalized;
        setColorTheme(next_theme, false);
    }
    syncSettingsPreferenceControls();
}

function syncSettingsPreferenceControls() {
    if (!settings_theme_elem) {
        return;
    }
    settings_theme_elem.value = getStoredThemePreference();
    settings_snippet_mode_elem.value = getSnippetInsertionMode();
    settings_abort_preview_elem.checked = shouldAbortAtPreviewLimit();
    settings_query_cache_elem.checked = shouldUseQueryCacheForDownload();
    settings_navigator_types_elem.checked = shouldShowNavigatorTypes();
    settings_compact_editor_elem.checked = document.getElementById('query_div').classList.contains('compact');
    const url_theme = current_url.searchParams.get('theme');
    setSettingsMessage(settings_preferences_message_elem,
        ['dark', 'light'].includes(url_theme) ? `The URL theme=${url_theme} override is currently active.` : '');
}

function getScopeQueryDefaultRecords(scope, connection_id = '') {
    return (query_defaults_state?.records || [])
        .filter(record => !isDeletedStorageRecord(record)
            && record.scope == scope
            && (scope != 'connection' || record.connection_id == connection_id))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveEffectiveQueryDefaults(connection_id = current_connection_id, candidate = null) {
    const global_records = candidate?.scope == 'global'
        ? candidate.rows.map(row => ({ ...row, scope: 'global', connection_id: '' }))
        : getScopeQueryDefaultRecords('global');
    const connection_records = candidate?.scope == 'connection' && candidate.connection_id == connection_id
        ? candidate.rows.map(row => ({ ...row, scope: 'connection', connection_id }))
        : getScopeQueryDefaultRecords('connection', connection_id);
    const effective = new Map();
    for (const record of global_records) {
        if (record.mode != 'suppress' && clickhouse_setting_identifier_pattern.test(record.name)
            && !isReservedQueryDefaultName(record.name)) {
            effective.set(record.name, { name: record.name, value: String(record.value ?? ''), source: 'Global' });
        }
    }
    for (const record of connection_records) {
        if (record.mode == 'suppress') {
            effective.delete(record.name);
        } else if (clickhouse_setting_identifier_pattern.test(record.name) && !isReservedQueryDefaultName(record.name)) {
            effective.set(record.name, { name: record.name, value: String(record.value ?? ''), source: 'Connection' });
        }
    }
    return effective;
}

function getEffectiveQueryDefaultParams() {
    return Object.fromEntries([...resolveEffectiveQueryDefaults().values()].map(row => [row.name, row.value]));
}

function getQueryDefaultDraftKey(scope, connection_id) {
    return scope == 'global' ? 'global' : `connection:${connection_id || ''}`;
}

function getQueryDefaultDraft(scope) {
    const connection_id = scope == 'connection' ? String(current_connection_id || '') : '';
    const key = getQueryDefaultDraftKey(scope, connection_id);
    let draft = settings_query_default_drafts.get(key);
    if (!draft) {
        draft = {
            scope,
            connection_id,
            dirty: false,
            rows: getScopeQueryDefaultRecords(scope, connection_id).map(record => ({
                name: record.name,
                value: record.value,
                mode: record.mode,
                persisted: true
            }))
        };
        settings_query_default_drafts.set(key, draft);
    }
    return draft;
}

function markQueryDefaultDraftChanged(draft) {
    draft.dirty = true;
    setSettingsMessage(settings_query_default_message_elem, 'Unsaved changes.');
}

function getQueryDefaultRowWarning(row, allow_suppress) {
    const validation = validateSettingRow(row, { allow_suppress, allow_unavailable: row.persisted });
    if (validation) {
        return validation;
    }
    const setting = getSettingCatalogEntry(row.name);
    return setting ? '' : 'Unknown on the active connection; the saved value is retained.';
}

function createQueryDefaultEditorRow(row, draft, options = {}) {
    const container = document.createElement('div');
    container.className = `settings-editor-row${options.inherited ? ' inherited' : ''}`;

    const name_main = document.createElement('div');
    name_main.className = 'settings-editor-row-main';
    const name_input = document.createElement('input');
    name_input.type = 'text';
    name_input.placeholder = 'Setting name';
    name_input.spellcheck = false;
    name_input.value = row.name;
    name_input.disabled = options.readonly;
    const help = document.createElement('div');
    help.className = 'settings-setting-help';
    let defer_name_validation = false;
    const render_help = () => {
        const setting = getSettingCatalogEntry(row.name);
        if (defer_name_validation && !setting) {
            help.className = 'settings-setting-help';
            help.textContent = 'Search by setting name, description, or type.';
            help.title = help.textContent;
            container.classList.remove('invalid');
            return;
        }
        const warning = getQueryDefaultRowWarning(row, draft?.scope == 'connection');
        help.className = warning ? 'settings-setting-warning' : 'settings-setting-help';
        help.textContent = warning || formatSettingHelp(setting);
        help.title = help.textContent;
        container.classList.toggle('invalid', !!warning && !options.readonly);
    };
    name_main.append(name_input, help);

    const value_input = document.createElement('input');
    value_input.type = 'text';
    value_input.className = 'monospace';
    value_input.placeholder = 'Raw value';
    value_input.spellcheck = false;
    value_input.value = row.value;
    value_input.disabled = options.readonly || row.mode == 'suppress';

    const mode_select = document.createElement('select');
    const set_option = document.createElement('option');
    set_option.value = 'set';
    set_option.textContent = 'Set';
    mode_select.appendChild(set_option);
    if (draft?.scope == 'connection') {
        const suppress_option = document.createElement('option');
        suppress_option.value = 'suppress';
        suppress_option.textContent = 'Suppress global';
        mode_select.appendChild(suppress_option);
    }
    mode_select.value = row.mode || 'set';
    mode_select.disabled = options.readonly;

    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = options.inherited ? 'Suppress' : 'Remove';

    if (options.inherited) {
        name_input.disabled = true;
        value_input.disabled = true;
        mode_select.disabled = true;
        const source = document.createElement('span');
        source.className = 'settings-source-badge';
        source.textContent = 'Inherited global';
        mode_select.replaceWith(source);
        action.addEventListener('click', () => {
            draft.rows.push({ name: row.name, value: '', mode: 'suppress' });
            markQueryDefaultDraftChanged(draft);
            renderQueryDefaultsEditor();
        });
        container.append(name_main, value_input, source, action);
    } else {
        name_input.addEventListener('input', () => {
            row.name = name_input.value.trim();
            row.persisted = false;
            defer_name_validation = true;
            markQueryDefaultDraftChanged(draft);
            render_help();
        });
        value_input.addEventListener('input', () => {
            row.value = value_input.value;
            row.persisted = false;
            markQueryDefaultDraftChanged(draft);
            render_help();
        });
        mode_select.addEventListener('change', () => {
            row.mode = mode_select.value;
            row.persisted = false;
            value_input.disabled = row.mode == 'suppress';
            markQueryDefaultDraftChanged(draft);
            render_help();
        });
        action.addEventListener('click', () => {
            draft.rows.splice(draft.rows.indexOf(row), 1);
            markQueryDefaultDraftChanged(draft);
            renderQueryDefaultsEditor();
        });
        registerSettingsCatalogComboboxInput(name_input, {
            onSelect: setting => {
                row.name = setting.name;
                row.persisted = false;
                defer_name_validation = false;
                markQueryDefaultDraftChanged(draft);
                render_help();
            },
            onBlur: () => {
                defer_name_validation = false;
                render_help();
            }
        });
        container.append(name_main, value_input, mode_select, action);
    }
    render_help();
    return container;
}

function createEffectiveQueryDefaultRow(row) {
    const container = document.createElement('div');
    container.className = 'settings-editor-row';
    const name_main = document.createElement('div');
    name_main.className = 'settings-editor-row-main';
    const name = document.createElement('strong');
    name.className = 'monospace';
    name.textContent = row.name;
    name.title = row.name;
    const setting = getSettingCatalogEntry(row.name);
    const help = document.createElement('div');
    const warning = !setting
        ? 'Unknown on the active connection; the saved value will still be sent.'
        : validateSettingRow(row, { allow_unavailable: true });
    help.className = warning ? 'settings-setting-warning' : 'settings-setting-help';
    help.textContent = warning || formatSettingHelp(setting);
    help.title = help.textContent;
    name_main.append(name, help);
    const value = document.createElement('code');
    value.textContent = row.value;
    const source = document.createElement('span');
    source.className = 'settings-source-badge';
    source.textContent = row.source;
    container.append(name_main, value, source, document.createElement('span'));
    return container;
}

function renderQueryDefaultsEditor() {
    if (!settings_query_default_rows_elem) {
        return;
    }
    closeSettingsCatalogCombobox('rerender');
    const scope = settings_query_default_scope_elem.value;
    const filter = settings_query_default_filter_elem.value.trim().toLowerCase();
    settings_query_default_rows_elem.replaceChildren();
    settings_query_default_add_elem.disabled = scope == 'effective' || !current_connection_id;
    settings_query_default_save_elem.disabled = scope == 'effective' || !current_connection_id;

    if (scope == 'effective') {
        const rows = [...resolveEffectiveQueryDefaults().values()].filter(row => {
            const setting = getSettingCatalogEntry(row.name);
            return !filter || row.name.toLowerCase().includes(filter) || setting?.description.toLowerCase().includes(filter);
        });
        for (const row of rows) {
            settings_query_default_rows_elem.appendChild(createEffectiveQueryDefaultRow(row));
        }
        if (!rows.length) {
            settings_query_default_rows_elem.appendChild(createSettingsEmpty('No effective Query Defaults.'));
        }
        return;
    }

    const draft = getQueryDefaultDraft(scope);
    const own_names = new Set(draft.rows.map(row => row.name));
    const rows = draft.rows.filter(row => {
        const setting = getSettingCatalogEntry(row.name);
        return !filter || row.name.toLowerCase().includes(filter) || setting?.description.toLowerCase().includes(filter);
    });
    for (const row of rows) {
        settings_query_default_rows_elem.appendChild(createQueryDefaultEditorRow(row, draft));
    }

    if (scope == 'connection') {
        const inherited = getScopeQueryDefaultRecords('global')
            .filter(row => !own_names.has(row.name))
            .filter(row => {
                const setting = getSettingCatalogEntry(row.name);
                return !filter || row.name.toLowerCase().includes(filter) || setting?.description.toLowerCase().includes(filter);
            });
        for (const row of inherited) {
            settings_query_default_rows_elem.appendChild(createQueryDefaultEditorRow(row, draft, { inherited: true }));
        }
    }

    if (!settings_query_default_rows_elem.children.length) {
        settings_query_default_rows_elem.appendChild(createSettingsEmpty(
            scope == 'connection' ? 'No connection-specific Query Defaults. New rows default to this scope.' : 'No global Query Defaults.'));
    }
}

function validateRows(rows, allow_suppress, allow_persisted_unavailable = false) {
    const errors = [];
    const names = new Set();
    for (const row of rows) {
        const name = String(row.name || '').trim();
        const error = validateSettingRow(row, {
            allow_suppress,
            allow_unavailable: allow_persisted_unavailable && row.persisted
        });
        if (error) {
            errors.push(`${name || 'New row'}: ${error}`);
        }
        if (names.has(name)) {
            errors.push(`${name}: duplicate setting in this scope.`);
        }
        names.add(name);
    }
    return errors;
}

function saveCurrentQueryDefaultDraft() {
    const scope = settings_query_default_scope_elem.value;
    if (!['global', 'connection'].includes(scope)) {
        return;
    }
    const draft = getQueryDefaultDraft(scope);
    if (scope == 'connection' && draft.connection_id != current_connection_id) {
        setSettingsMessage(settings_query_default_message_elem, 'The active connection changed. Review this connection’s draft before saving.', 'error');
        return;
    }
    const errors = validateRows(draft.rows, scope == 'connection', true);
    if (errors.length) {
        setSettingsMessage(settings_query_default_message_elem, errors.join(' '), 'error');
        renderQueryDefaultsEditor();
        return;
    }
    if (!replaceQueryDefaultsScope(scope, draft.connection_id, draft.rows)) {
        return;
    }
    draft.dirty = false;
    for (const row of draft.rows) {
        row.persisted = true;
    }
    setSettingsMessage(settings_query_default_message_elem, 'Query Defaults saved.', 'success');
    renderQueryDefaultsEditor();
}

function getCandidateEffectiveDefaults() {
    const scope = settings_query_default_scope_elem.value;
    if (!['global', 'connection'].includes(scope)) {
        return resolveEffectiveQueryDefaults();
    }
    const draft = getQueryDefaultDraft(scope);
    return resolveEffectiveQueryDefaults(current_connection_id, draft);
}

async function testEffectiveQueryDefaults() {
    const scope = settings_query_default_scope_elem.value;
    if (['global', 'connection'].includes(scope)) {
        const draft = getQueryDefaultDraft(scope);
        const errors = validateRows(draft.rows, scope == 'connection', true);
        if (errors.length) {
            setSettingsMessage(settings_query_default_message_elem, errors.join(' '), 'error');
            renderQueryDefaultsEditor();
            return;
        }
    }
    const connection = getCurrentSettingsConnection();
    const params = Object.fromEntries([...getCandidateEffectiveDefaults().values()].map(row => [row.name, row.value]));
    settings_query_default_test_elem.disabled = true;
    setSettingsMessage(settings_query_default_message_elem, 'Testing effective settings…');
    try {
        const url = buildClickHouseUrl(connection.url, connection.user, connection.password, 'JSONEachRow', params);
        const response = await fetch(url, { method: 'POST', body: 'SELECT 1' });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(text || `Test failed (${response.status}).`);
        }
        setSettingsMessage(settings_query_default_message_elem, 'Effective settings accepted by ClickHouse.', 'success');
    } catch (error) {
        setSettingsMessage(settings_query_default_message_elem, error.message || 'Effective settings test failed.', 'error');
    } finally {
        settings_query_default_test_elem.disabled = false;
    }
}

function resetSessionDraft() {
    const connection = getCurrentSettingsConnection();
    const record = getSessionRecord();
    settings_session_draft = {
        connection_id: connection.id,
        rows: Object.entries(record.managed).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }))
    };
}

function createSessionSettingRow(row) {
    const container = document.createElement('div');
    container.className = 'settings-editor-row';
    const name_main = document.createElement('div');
    name_main.className = 'settings-editor-row-main';
    const name_input = document.createElement('input');
    name_input.type = 'text';
    name_input.placeholder = 'Setting name';
    name_input.spellcheck = false;
    name_input.value = row.name;
    const help = document.createElement('div');
    let defer_name_validation = false;
    const render_help = () => {
        const setting = getSettingCatalogEntry(row.name);
        if (defer_name_validation && !setting) {
            help.className = 'settings-setting-help';
            help.textContent = 'Search by setting name, description, or type.';
            help.title = help.textContent;
            container.classList.remove('invalid');
            return;
        }
        const warning = validateSettingRow(row);
        help.className = warning ? 'settings-setting-warning' : 'settings-setting-help';
        help.textContent = warning || formatSettingHelp(setting);
        help.title = help.textContent;
        container.classList.toggle('invalid', !!warning);
    };
    name_main.append(name_input, help);
    const value_input = document.createElement('input');
    value_input.type = 'text';
    value_input.className = 'monospace';
    value_input.placeholder = 'Raw value';
    value_input.spellcheck = false;
    value_input.value = row.value;
    const managed_badge = document.createElement('span');
    managed_badge.className = 'settings-source-badge';
    managed_badge.textContent = 'Managed';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    name_input.addEventListener('input', () => {
        row.name = name_input.value.trim();
        defer_name_validation = true;
        render_help();
    });
    value_input.addEventListener('input', () => {
        row.value = value_input.value;
        render_help();
    });
    remove.addEventListener('click', () => {
        settings_session_draft.rows.splice(settings_session_draft.rows.indexOf(row), 1);
        renderSessionSettingsEditor();
    });
    registerSettingsCatalogComboboxInput(name_input, {
        onSelect: setting => {
            row.name = setting.name;
            defer_name_validation = false;
            render_help();
        },
        onBlur: () => {
            defer_name_validation = false;
            render_help();
        }
    });
    container.append(name_main, value_input, managed_badge, remove);
    render_help();
    return container;
}

function renderSessionSettingsEditor() {
    if (!settings_session_rows_elem) {
        return;
    }
    closeSettingsCatalogCombobox('rerender');
    const connection = getCurrentSettingsConnection();
    if (settings_session_draft.connection_id != connection.id) {
        resetSessionDraft();
    }
    settings_session_rows_elem.replaceChildren();
    for (const row of settings_session_draft.rows) {
        settings_session_rows_elem.appendChild(createSessionSettingRow(row));
    }
    if (!settings_session_draft.rows.length) {
        settings_session_rows_elem.appendChild(createSettingsEmpty('No managed Session Settings. Editor queries still share an HTTP session.'));
    }
    renderSessionStatus();
}

function buildSessionSetQuery(managed, reset_names = []) {
    const assignments = [];
    for (const name of reset_names) {
        if (clickhouse_setting_identifier_pattern.test(name) && !(name in managed)) {
            assignments.push(`${name} = DEFAULT`);
        }
    }
    for (const [name, value] of Object.entries(managed)) {
        assignments.push(`${name} = ${formatClickHouseStringLiteral(value)}`);
    }
    return assignments.length ? `SET ${assignments.join(', ')}` : 'SELECT 1';
}

async function getClickHouseExceptionCode(response) {
    const header_code = Number(response.headers.get('X-ClickHouse-Exception-Code') || 0);
    if (header_code) {
        return header_code;
    }
    if (response.ok) {
        return 0;
    }
    try {
        const text = await response.clone().text();
        return Number(text.match(/\bCode:\s*(\d+)/i)?.[1] || 0);
    } catch (e) {
        return 0;
    }
}

async function sendSessionManagementQuery(record, query, check_existing, signal) {
    const connection = getCurrentSettingsConnection();
    const params = {
        session_id: record.transport_id,
        session_timeout: settings_session_timeout_seconds
    };
    if (check_existing) {
        params.session_check = '1';
    }
    const url = buildClickHouseUrl(connection.url, connection.user, connection.password, 'JSONEachRow', params);
    const response = await fetch(url, { method: 'POST', body: query, signal });
    if (!response.ok) {
        const code = await getClickHouseExceptionCode(response);
        const text = await response.text();
        throw new ClickHouseSessionError(text || `Session request failed (${response.status}).`, code);
    }
    await response.text();
}

async function bootstrapManagedSession(record, managed = record.managed, signal) {
    if (!record.transport_id) {
        record.transport_id = createTransportSessionId();
    }
    await sendSessionManagementQuery(record, buildSessionSetQuery(managed), false, signal);
    record.active = true;
    record.applied_names = Object.keys(managed);
    record.status = 'active';
    record.message = '';
    persistSessionSettingsStore();
    renderSessionStatus();
}

function rotateSessionTransport(record, status = 'not-started') {
    record.transport_id = createTransportSessionId();
    record.applied_names = [];
    record.active = false;
    record.status = status;
    record.message = '';
    persistSessionSettingsStore();
}

async function ensureInteractiveSession(signal) {
    const record = getSessionRecord();
    if (!record.active || !record.transport_id) {
        if (!record.transport_id) {
            rotateSessionTransport(record);
        }
        try {
            await bootstrapManagedSession(record, record.managed, signal);
        } catch (error) {
            record.status = error.code == 373 ? 'busy' : 'error';
            record.message = error.code == 373 ? 'The HTTP session is busy; the request was not retried.' : 'Could not start the HTTP session.';
            persistSessionSettingsStore();
            renderSessionStatus();
            throw error;
        }
    }
    return record;
}

function buildInteractiveQueryUrl(extra_params, record) {
    const connection = getCurrentSettingsConnection();
    return buildClickHouseUrl(connection.url, connection.user, connection.password, default_format, {
        ...extra_params,
        ...getEffectiveQueryDefaultParams(),
        session_id: record.transport_id,
        session_timeout: settings_session_timeout_seconds,
        session_check: '1'
    });
}

async function fetchInteractiveQuery(query, extra_params, signal) {
    let record = await ensureInteractiveSession(signal);
    let response = await fetch(buildInteractiveQueryUrl(extra_params, record), {
        method: 'POST',
        body: query,
        signal,
        headers: { 'Authorization': 'never' }
    });
    let exception_code = await getClickHouseExceptionCode(response);

    if (exception_code == 372) {
        record.status = 'recovering';
        record.message = 'The server session expired. Managed settings are being replayed; unmanaged session state was lost.';
        rotateSessionTransport(record, 'recovering');
        renderSessionStatus();
        try {
            await bootstrapManagedSession(record, record.managed, signal);
            response = await fetch(buildInteractiveQueryUrl(extra_params, record), {
                method: 'POST',
                body: query,
                signal,
                headers: { 'Authorization': 'never' }
            });
            exception_code = await getClickHouseExceptionCode(response);
        } catch (error) {
            record.status = error.code == 373 ? 'busy' : 'error';
            record.message = 'Session recovery failed. The editor query was not executed.';
            persistSessionSettingsStore();
            renderSessionStatus();
            throw error;
        }
    }

    if (exception_code == 373) {
        record.status = 'busy';
        record.message = 'The HTTP session is busy. ClickHouse rejected the request and it was not retried.';
    } else if (response.ok) {
        record.status = 'active';
        record.message = '';
    } else if (exception_code == 372) {
        record.status = 'error';
        record.message = 'The recovered HTTP session was not found. The query was not retried again.';
    }
    persistSessionSettingsStore();
    renderSessionStatus();
    return response;
}

async function applySessionSettings() {
    const connection = getCurrentSettingsConnection();
    if (in_flight || settings_session_draft.connection_id != connection.id) {
        setSettingsMessage(settings_session_message_elem, 'Wait for the editor query to finish, then review the active connection.', 'error');
        return;
    }
    const errors = validateRows(settings_session_draft.rows, false);
    if (errors.length) {
        setSettingsMessage(settings_session_message_elem, errors.join(' '), 'error');
        renderSessionSettingsEditor();
        return;
    }

    const managed = Object.fromEntries(settings_session_draft.rows.map(row => [row.name, String(row.value ?? '')]));
    const record = getSessionRecord();
    const previous_applied_names = [...record.applied_names];
    updateSessionSettingsBusyState(true);
    setSettingsMessage(settings_session_message_elem, 'Applying managed Session Settings…');
    try {
        if (!record.active || !record.transport_id) {
            rotateSessionTransport(record);
            await bootstrapManagedSession(record, managed);
        } else {
            try {
                await sendSessionManagementQuery(record, buildSessionSetQuery(managed, previous_applied_names), true);
            } catch (error) {
                if (error.code != 372) {
                    throw error;
                }
                rotateSessionTransport(record, 'recovering');
                await bootstrapManagedSession(record, managed);
            }
            record.active = true;
            record.applied_names = Object.keys(managed);
        }
        record.managed = managed;
        record.status = 'active';
        record.message = '';
        persistSessionSettingsStore();
        setSettingsMessage(settings_session_message_elem, 'Session Settings applied.', 'success');
    } catch (error) {
        record.status = error.code == 373 ? 'busy' : 'error';
        record.message = error.code == 373
            ? 'The HTTP session is busy. The changes were not applied or retried.'
            : (error.message || 'Session Settings were rejected by ClickHouse.');
        persistSessionSettingsStore();
        setSettingsMessage(settings_session_message_elem, record.message, 'error');
    } finally {
        renderSessionStatus();
        updateSessionSettingsBusyState();
    }
}

async function restartManagedSession() {
    if (in_flight) {
        return;
    }
    const record = getSessionRecord();
    updateSessionSettingsBusyState(true);
    setSettingsMessage(settings_session_message_elem, 'Starting a new HTTP session…');
    rotateSessionTransport(record);
    try {
        await bootstrapManagedSession(record, record.managed);
        setSettingsMessage(settings_session_message_elem, 'New HTTP session started and managed settings replayed.', 'success');
    } catch (error) {
        record.status = error.code == 373 ? 'busy' : 'error';
        record.message = error.message || 'Could not restart the HTTP session.';
        persistSessionSettingsStore();
        setSettingsMessage(settings_session_message_elem, record.message, 'error');
    } finally {
        renderSessionStatus();
        updateSessionSettingsBusyState();
    }
}

function updateSessionSettingsBusyState(force_busy = false) {
    if (!settings_session_apply_elem) {
        return;
    }
    const disabled = force_busy || in_flight || !current_connection_id;
    settings_session_apply_elem.disabled = disabled;
    settings_session_restart_elem.disabled = disabled;
    settings_session_add_elem.disabled = disabled;
}

function handleQueryDefaultsChanged() {
    const next_state = loadQueryDefaults();
    if (next_state.unsupported_schema) {
        setSettingsMessage(settings_query_default_message_elem,
            `Query Defaults use newer storage schema ${next_state.unsupported_schema_version}; this client will not overwrite them.`, 'error');
        return;
    }
    query_defaults_state = next_state;
    for (const [key, draft] of settings_query_default_drafts) {
        if (!draft.dirty) {
            settings_query_default_drafts.delete(key);
        }
    }
    renderQueryDefaultsEditor();
}

function handleSettingsPreferenceStorageChanged(key) {
    if (key == theme_key) {
        if (!['dark', 'light'].includes(current_url.searchParams.get('theme'))) {
            const preference = getStoredThemePreference();
            const next_theme = preference == 'system'
                ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                : preference;
            setColorTheme(next_theme, false);
        }
    } else if (key == download_query_cache_key) {
        setDownloadQueryCachePreference(window.localStorage.getItem(key) == '1', false);
    } else if (key == navigator_show_types_key) {
        setNavigatorTypesVisible(window.localStorage.getItem(key) == '1', false);
    } else if (key == abort_preview_limit_key) {
        setAbortPreviewLimit(window.localStorage.getItem(key) == '1', false);
    } else if (key == query_editor_compact_key) {
        setEditorCompact(window.localStorage.getItem(key) == '1', false);
    } else if (key == snippet_insertion_mode_key) {
        setSnippetInsertionMode(window.localStorage.getItem(key) || 'append', false);
    }
    syncSettingsPreferenceControls();
}

function handleSettingsConnectionChanged(connection) {
    if (!settings_initialized) {
        return;
    }
    settings_connection_name_elem.textContent = connection?.name || 'the active connection';
    settings_session_connection_elem.textContent = connection?.name || 'None';
    const record = getSessionRecord();
    const revision = String(connection?.updated_at || '');
    if (record.connection_revision && revision && record.connection_revision != revision) {
        rotateSessionTransport(record);
    }
    record.connection_revision = revision;
    persistSessionSettingsStore();
    settings_active_catalog = null;
    const cached = settings_catalog_cache.get(connection.id);
    if (cached?.identity == getCatalogIdentity(getCurrentSettingsConnection()) && cached.catalog) {
        settings_active_catalog = cached.catalog;
    }
    resetSessionDraft();
    renderSettingsCatalog();
    renderSessionSettingsEditor();
    renderQueryDefaultsEditor();
    setSettingsMessage(settings_session_message_elem, record.message || '');
    setSettingsMessage(settings_query_default_message_elem, '');
    if (current_workspace_view == 'settings') {
        void loadSettingsCatalog().catch(() => {});
    }
}

async function ensureSettingsLoaded() {
    syncSettingsPreferenceControls();
    renderSessionSettingsEditor();
    renderQueryDefaultsEditor();
    if (!settings_active_catalog && current_connection_id) {
        try {
            await loadSettingsCatalog();
        } catch (e) {
            // Section-local status already explains the failure.
        }
    }
}

function initializeSettingsWorkspace() {
    if (settings_initialized) {
        return;
    }
    settings_initialized = true;
    query_defaults_state = loadQueryDefaults();

    settings_catalog_refresh_elem.addEventListener('click', () => {
        void loadSettingsCatalog(true).catch(() => {});
    });
    settings_theme_elem.addEventListener('change', () => applyThemePreference(settings_theme_elem.value));
    settings_snippet_mode_elem.addEventListener('change', () => setSnippetInsertionMode(settings_snippet_mode_elem.value));
    settings_abort_preview_elem.addEventListener('change', () => setAbortPreviewLimit(settings_abort_preview_elem.checked));
    settings_query_cache_elem.addEventListener('change', () => setDownloadQueryCachePreference(settings_query_cache_elem.checked));
    settings_navigator_types_elem.addEventListener('change', () => setNavigatorTypesVisible(settings_navigator_types_elem.checked));
    settings_compact_editor_elem.addEventListener('change', () => setEditorCompact(settings_compact_editor_elem.checked));

    settings_session_add_elem.addEventListener('click', () => {
        settings_session_draft.rows.push({ name: '', value: '' });
        renderSessionSettingsEditor();
    });
    settings_session_apply_elem.addEventListener('click', () => void applySessionSettings());
    settings_session_restart_elem.addEventListener('click', () => void restartManagedSession());

    settings_query_default_scope_elem.addEventListener('change', renderQueryDefaultsEditor);
    settings_query_default_filter_elem.addEventListener('input', renderQueryDefaultsEditor);
    settings_query_default_add_elem.addEventListener('click', () => {
        let scope = settings_query_default_scope_elem.value;
        if (!['global', 'connection'].includes(scope)) {
            scope = 'connection';
            settings_query_default_scope_elem.value = scope;
        }
        const draft = getQueryDefaultDraft(scope);
        draft.rows.push({ name: '', value: '', mode: 'set', persisted: false });
        markQueryDefaultDraftChanged(draft);
        renderQueryDefaultsEditor();
    });
    settings_query_default_save_elem.addEventListener('click', saveCurrentQueryDefaultDraft);
    settings_query_default_test_elem.addEventListener('click', () => void testEffectiveQueryDefaults());
    settings_catalog_combobox_elem.addEventListener('scroll', () => renderSettingsCatalogComboboxVirtualWindow(),
        { passive: true });
    settings_workspace_elem.addEventListener('scroll', positionSettingsCatalogCombobox, { passive: true });
    window.addEventListener('resize', positionSettingsCatalogCombobox, { passive: true });
    if (typeof ResizeObserver == 'function') {
        new ResizeObserver(positionSettingsCatalogCombobox).observe(settings_workspace_elem);
    }

    syncSettingsPreferenceControls();
    settings_connection_name_elem.textContent = current_connection_name || 'the active connection';
    settings_session_connection_elem.textContent = current_connection_name || 'None';
    resetSessionDraft();
    renderSessionSettingsEditor();
    renderQueryDefaultsEditor();
}
