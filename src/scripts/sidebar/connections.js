async function ping(url) {
    try {
        let response = await fetch(new URL(url).origin + "?query", { method: 'OPTIONS', headers: { 'Authorization': 'never' } });
        return response.ok;
    } catch (e) {
        return false;
    }
}

let ping_request_num = 0;
function checkURL() {
    ++ping_request_num;
    const current_ping_request_num = ping_request_num;
    let elem = document.getElementById('url_status');
    elem.className = '';
    document.getElementById('server_info').innerText = 'Checking connection...';
    ping(url_elem.value).then(status => {
        if (current_ping_request_num == ping_request_num) {
            elem.className = status ? 'ok' : 'fail';
            if (status) {
                checkCredentials();
            } else {
                document.getElementById('server_info').innerText = 'Server unavailable';
            }
        }
    });
};

url_elem.addEventListener('input', checkURL);
checkURL();

async function getServerStatus(server_address, user, password) {
    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?') +
        'add_http_cors_header=1&default_format=JSONEachRow';
    if (user) url += '&user=' + encodeURIComponent(user);
    if (password) url += '&password=' + encodeURIComponent(password);
    try {
        let response = await fetch(url, { method: "POST", body: "SELECT version() AS v, uptime() AS t", headers: { 'Authorization': 'never' } });
        if (!response.ok) return false;
        json = await response.json();
        return json;
    } catch (e) {
        return false;
    }
}

let load_databases_request_num = 0;
async function loadDatabases(server_address, user, password) {
    ++load_databases_request_num;
    const current_load_databases_request_num = load_databases_request_num;
    const target_connection_id = current_connection_id;
    closeAutocomplete();
    ++autocomplete_schema_revision;
    autocomplete_table_loads = {};
    autocomplete_column_loads = {};
    schema_state = {
        loading: true,
        connection_id: target_connection_id,
        databases: [],
        tables: {},
        columns: {},
        loading_tables: {},
        table_messages: {},
        message: 'Loading schema...'
    };
    renderNavigatorTree();

    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?') +
        'add_http_cors_header=1&default_format=JSON';
    if (user) url += '&user=' + encodeURIComponent(user);
    if (password) url += '&password=' + encodeURIComponent(password);

    let response = await fetch(url, {
        method: "POST",
        body: `SELECT database, database = currentDatabase() AS current
            FROM system.databases WHERE database != 'INFORMATION_SCHEMA'
            ORDER BY
                database = 'information_schema',
                database = 'system',
                database != 'default',
                database`,
        headers: { 'Authorization': 'never' } });
    if (!response.ok) {
        schema_state = {
            loading: false,
            connection_id: target_connection_id,
            databases: [],
            tables: {},
            columns: {},
            loading_tables: {},
            table_messages: {},
            message: 'Failed to load schema.'
        };
        ++autocomplete_schema_revision;
        renderNavigatorTree();
        return false;
    }
    json = await response.json();

    if (current_load_databases_request_num != load_databases_request_num) return false;
    if (target_connection_id != current_connection_id) return false;

    // Use natural order for database names
    json.data.sort((a, b) => {
        // Maintain original order for default, system, information_schema
        const getPriority = (name) => {
            switch (name) {
                case 'default': return 0;
                case 'system': return 2;
                case 'information_schema': return 3
                default: return 1;
            }
        }

        return getPriority(a.database) - getPriority(b.database)
            || a.database.localeCompare(b.database, undefined, { numeric: true });
    });

    schema_state = {
        loading: false,
        connection_id: target_connection_id,
        databases: json.data,
        tables: {},
        columns: {},
        loading_tables: {},
        table_messages: {},
        message: json.data.length ? '' : 'No databases found.'
    };
    ++autocomplete_schema_revision;
    renderNavigatorTree();
}

async function loadTables(server_address, user, password, database) {
    schema_state.loading_tables[database] = true;
    delete schema_state.table_messages[database];
    renderNavigatorTree();

    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?') +
        'add_http_cors_header=1&default_format=JSON';
    if (user) url += '&user=' + encodeURIComponent(user);
    if (password) url += '&password=' + encodeURIComponent(password);
    url += '&param_database=' + encodeURIComponent(database);

    let response = await fetch(url, {
        method: "POST",
        body: `SELECT table, engine, total_rows, total_bytes FROM system.tables WHERE database = {database:String}
            ORDER BY table LIKE '.inner%', table`,
        headers: { 'Authorization': 'never' } });
    if (!response.ok) {
        delete schema_state.loading_tables[database];
        schema_state.table_messages[database] = 'Failed to load tables.';
        renderNavigatorTree();
        return false;
    }
    json = await response.json();

    if (schema_state.connection_id != current_connection_id) return false;

    delete schema_state.loading_tables[database];
    delete schema_state.table_messages[database];
    schema_state.tables[database] = json.data;
    ++autocomplete_schema_revision;
    renderNavigatorTree();
    refreshAutocompleteFromEditor();
    return json.data;
}

let load_columns_request_num = 0;
function renderColumns(container, columns, database, table) {
    container.innerHTML = '';
    container.dataset.loaded = '1';

    for (let column of columns) {
        let row = document.createElement('div');
        row.className = 'column';
        const is_numeric_column = isNumericClickHouseType(column.type);

        if (is_numeric_column) {
            row.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                openColumnMenu({ left: e.clientX, bottom: e.clientY }, database, table, column);
            });
        }

        let name = document.createElement('span');
        name.className = 'column-name monospace';
        name.innerText = column.name;
        name.title = is_numeric_column
            ? 'Double-click to insert column name at cursor. Right-click to generate stats'
            : 'Double-click to insert column name at cursor';
        name.addEventListener('dblclick', e => {
            e.stopPropagation();
            insertIntoQueryEditor(formatClickHouseIdentifier(column.name), { mode: 'insert' });
        });

        let type = document.createElement('span');
        type.className = 'column-type monospace';
        type.innerText = column.type;

        row.appendChild(name);
        row.appendChild(type);
        container.appendChild(row);
    }
}

async function loadColumns(server_address, user, password, database, table, container) {
    ++load_columns_request_num;
    const current_load_columns_request_num = load_columns_request_num;
    const cache_key = getSchemaTableKey(database, table);

    if (schema_state.columns[cache_key]) {
        renderColumns(container, schema_state.columns[cache_key], database, table);
        return schema_state.columns[cache_key];
    }

    container.innerHTML = 'loading columns...';

    const columns = await fetchTableColumns(server_address, user, password, database, table);
    if (columns === false) {
        container.innerText = 'failed to load columns';
        return false;
    }
    if (current_load_columns_request_num != load_columns_request_num) return false;

    schema_state.columns[cache_key] = columns;
    ++autocomplete_schema_revision;
    renderColumns(container, columns, database, table);
    refreshAutocompleteFromEditor();
    return columns;
}

let databases_toggle = document.getElementById('databases-toggle');
databases_toggle.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    setSidebarCollapsed(collapsed);
});

function appendSidebarResizer() {
    let drag_state = {
        is_dragging: false,
        offset_x: null,
        offset_width: null,
        current_width: null
    };

    const start = (e) => {
        if (e.button !== 0 || document.body.classList.contains('sidebar-collapsed')) {
            return;
        }

        drag_state.offset_x = e.clientX;
        drag_state.offset_width = menu_elem.getBoundingClientRect().width;
        drag_state.current_width = drag_state.offset_width;
        drag_state.is_dragging = true;
        document.body.classList.add('sidebar-resizing');

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);
    };

    const move = (e) => {
        if (!drag_state.is_dragging) {
            return;
        }

        drag_state.current_width = drag_state.offset_width + (e.clientX - drag_state.offset_x);
        setSidebarWidth(drag_state.current_width, false);
    };

    const stop = () => {
        if (!drag_state.is_dragging) {
            return;
        }

        drag_state.is_dragging = false;
        document.body.classList.remove('sidebar-resizing');
        setSidebarWidth(drag_state.current_width, true);

        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
    };

    sidebar_resizer_elem.addEventListener('pointerdown', start);
    sidebar_resizer_elem.addEventListener('touchstart', (e) => e.preventDefault());
}

function formatUptime(t) {
    if (t < 60) { return t + " sec" }
    if (t < 3600) { return Number(t / 60).toFixed() + " min" }
    if (t < 86400) { return Number(t / 3600).toFixed() + " hr" }
    const days = Number(t / 86400).toFixed();
    return days + " day" + (days > 1 ? 's' : '');
}

let check_credentials_request_num = 0;
function checkCredentials() {
    ++check_credentials_request_num;
    const current_check_credentials_request_num = check_credentials_request_num;
    getServerStatus(url_elem.value, user_elem.value, password_elem.value).then(json => {
        if (current_check_credentials_request_num == check_credentials_request_num) {
            if (json) {
                [user_elem, password_elem].forEach(e => { e.classList.remove('fail'); e.classList.add('ok'); });
                document.getElementById('server_info').innerText = `v${json.v}, uptime ${formatUptime(json.t)} • ${user_elem.value || 'default'}`;
            } else {
                [user_elem, password_elem].forEach(e => { e.classList.remove('ok'); e.classList.add('fail'); });
                const status_elem = document.getElementById('url_status');
                status_elem.className = 'fail';
                document.getElementById('server_info').innerText = `Authentication failed • ${user_elem.value || 'default'}`;
            }
        }
    });
}

function resetCredentialsStatus() {
    [user_elem, password_elem].forEach(e => { e.classList.remove('ok'); e.classList.remove('fail'); });
}

user_elem.addEventListener('input', resetCredentialsStatus);
password_elem.addEventListener('input', resetCredentialsStatus);

/// The password is usually copy-pasted.
/// To not worry about extracting the clipboard data, but use the value instead,
/// and not worry too much about input/paste race, add the timeout.
user_elem.addEventListener('paste', () => setTimeout(checkCredentials, 100));
password_elem.addEventListener('paste', () => setTimeout(checkCredentials, 100));


function queryToColor(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    /// Limited range to avoid violet colors.
    return 50 + ((hash >>> 0) % 200);
}

function toBase64(str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    return btoa(binary);
}

function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
}
