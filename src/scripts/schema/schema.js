const schema_name_reserved_regexp = /^(distinct|all|table|select|from|values)$/i;

const schema_view_state = {
    initialized: false,
    loading: false,
    connection_id: '',
    generation: 0,
    tables: [],
    columns_by_table: new Map(),
    dict_sources: new Map(),
    refreshes: new Map(),
    nodes: new Map(),
    nodes_by_db: new Map(),
    edges: [],
    sections: [],
    show_columns: true,
    show_system: false,
    selected_databases: new Set(),
    selected_key: null,
    zoom: 1,
    load_period_days: 7,
    load_metric: 'written_rows',
    load_by_mv: new Map(),
    load_by_edge: new Map(),
    load_max: { by_mv: {}, by_edge: {} },
    target_metadata_source: 'native',
    target_metadata_database: 'system',
    search_timer: null
};

function schemaFullName(database, table) {
    return `${database}.${table}`;
}

function schemaBackQuoteIfNeed(value) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !schema_name_reserved_regexp.test(value)) {
        return value;
    }
    return `\`${String(value).replace(/`/g, '\\`')}\``;
}

function schemaQuotedFullName(database, table) {
    return `${schemaBackQuoteIfNeed(database)}.${schemaBackQuoteIfNeed(table)}`;
}

function getCurrentSchemaConnection() {
    return {
        id: current_connection_id || '',
        name: current_connection_name || 'Connection',
        url: url_elem.value || 'http://localhost:8123/',
        user: user_elem.value || 'default',
        password: password_elem.value || ''
    };
}

function resetSchemaStateForConnection(connection = getCurrentSchemaConnection()) {
    schema_view_state.connection_id = connection.id || '';
    schema_view_state.generation++;
    schema_view_state.loading = false;
    schema_view_state.tables = [];
    schema_view_state.columns_by_table = new Map();
    schema_view_state.dict_sources = new Map();
    schema_view_state.refreshes = new Map();
    schema_view_state.nodes = new Map();
    schema_view_state.nodes_by_db = new Map();
    schema_view_state.edges = [];
    schema_view_state.sections = [];
    schema_view_state.selected_key = null;
    schema_view_state.load_by_mv = new Map();
    schema_view_state.load_by_edge = new Map();
    schema_view_state.load_max = { by_mv: {}, by_edge: {} };
    schema_view_state.target_metadata_source = 'native';
    schema_view_state.target_metadata_database = 'system';
    schema_canvas_elem.querySelectorAll('.schema-node, .schema-db-group').forEach(element => element.remove());
    schema_links_svg_elem.innerHTML = '';
    schema_empty_elem.classList.remove('hidden');
    schema_sidebar_elem.classList.remove('open');
    setSchemaEmptyMessage('Load the schema for this connection.', 'Click a node to inspect it. Drag a node to reposition it.');
    schema_view_state.selected_databases = new Set();
    schema_db_filter_menu_elem.innerHTML = '';
    updateSchemaDbFilterButton();
    schemaSetStatus('Load the schema for this connection.');
    schemaApplyZoom();
}

function initializeSchemaView() {
    if (schema_view_state.initialized) {
        return;
    }

    schema_view_state.initialized = true;
    resetSchemaStateForConnection();

    schema_controls_elem.addEventListener('submit', event => event.preventDefault());
    schema_reload_elem.addEventListener('click', () => {
        void loadSchemaAll();
    });
    schema_relayout_elem.addEventListener('click', () => {
        schemaRender();
    });
    schema_db_filter_button_elem.addEventListener('click', () => {
        const next_hidden = !schema_db_filter_menu_elem.hidden;
        schema_db_filter_menu_elem.hidden = next_hidden;
        schema_db_filter_button_elem.setAttribute('aria-expanded', next_hidden ? 'false' : 'true');
    });
    schema_toggle_columns_elem.addEventListener('click', () => {
        schema_view_state.show_columns = !schema_view_state.show_columns;
        schema_toggle_columns_elem.classList.toggle('active', schema_view_state.show_columns);
        schema_toggle_columns_elem.setAttribute('aria-pressed', schema_view_state.show_columns ? 'true' : 'false');
        schemaRender();
    });
    schema_toggle_system_elem.addEventListener('click', () => {
        schema_view_state.show_system = !schema_view_state.show_system;
        schema_toggle_system_elem.classList.toggle('active', schema_view_state.show_system);
        schema_toggle_system_elem.setAttribute('aria-pressed', schema_view_state.show_system ? 'true' : 'false');
        void loadSchemaAll();
    });
    schema_load_period_elem.addEventListener('change', async () => {
        schema_view_state.load_period_days = Number(schema_load_period_elem.value) || 0;
        updateSchemaLoadLegendVisibility();
        if (schema_view_state.nodes.size) {
            await loadSchemaViewsLoad();
            schemaRender();
        }
    });
    schema_load_metric_elem.addEventListener('change', () => {
        schema_view_state.load_metric = schema_load_metric_elem.value;
        updateSchemaLoadLegendVisibility();
        schemaRender();
    });
    schema_search_elem.addEventListener('input', () => {
        clearTimeout(schema_view_state.search_timer);
        schema_view_state.search_timer = setTimeout(schemaRender, 160);
    });
    schema_sidebar_close_elem.addEventListener('click', clearSchemaHighlight);
    schema_viewport_elem.addEventListener('click', clearSchemaHighlight);
    document.addEventListener('click', event => {
        if (!schema_db_filter_elem.contains(event.target)) {
            closeSchemaDbFilterMenu();
        }
    });
    schema_zoom_in_elem.addEventListener('click', () => {
        schema_view_state.zoom = Math.min(2, schema_view_state.zoom * 1.2);
        schemaApplyZoom();
    });
    schema_zoom_out_elem.addEventListener('click', () => {
        schema_view_state.zoom = Math.max(0.2, schema_view_state.zoom / 1.2);
        schemaApplyZoom();
    });
    schema_zoom_reset_elem.addEventListener('click', () => {
        schema_view_state.zoom = 1;
        schemaApplyZoom();
    });
    document.addEventListener('keydown', event => {
        if (event.key == 'Escape' && current_workspace_view == 'schema') {
            closeSchemaDbFilterMenu();
            clearSchemaHighlight();
        }
    });

    schema_view_state.show_columns = schema_toggle_columns_elem.classList.contains('active');
    schema_view_state.show_system = schema_toggle_system_elem.classList.contains('active');
    schema_view_state.load_period_days = Number(schema_load_period_elem.value) || 0;
    schema_view_state.load_metric = schema_load_metric_elem.value;
    updateSchemaLoadLegendVisibility();
}

async function ensureSchemaLoaded({ reload = false } = {}) {
    initializeSchemaView();
    const connection = getCurrentSchemaConnection();
    if (schema_view_state.connection_id != connection.id || reload) {
        resetSchemaStateForConnection(connection);
    }

    if (schema_view_state.loading) {
        return;
    }

    if (reload || schema_view_state.tables.length == 0) {
        await loadSchemaAll();
    } else {
        schemaRender();
    }
}

function handleSchemaConnectionChanged(connection) {
    if (!schema_view_state.initialized) {
        return;
    }

    resetSchemaStateForConnection(connection);
    if (current_workspace_view == 'schema') {
        void ensureSchemaLoaded({ reload: true });
    }
}

function openSchemaForConnection(connection) {
    if (connection && connection.id != current_connection_id && typeof applyConnection == 'function') {
        applyConnection(connection);
    }
    setWorkspaceView('schema', { reload: true });
}

function schemaSetStatus(text, is_error = false) {
    schema_status_elem.textContent = text || '';
    schema_status_elem.classList.toggle('error', !!is_error);
}

function setSchemaEmptyMessage(title, detail) {
    const title_elem = schema_empty_elem.querySelector('strong');
    const detail_elem = schema_empty_elem.querySelector('span');
    if (title_elem) title_elem.textContent = title;
    if (detail_elem) detail_elem.textContent = detail;
}

function setSchemaControlsDisabled(disabled) {
    schema_view_state.loading = disabled;
    for (const element of [
        schema_reload_elem,
        schema_relayout_elem,
        schema_toggle_columns_elem,
        schema_toggle_system_elem,
        schema_load_period_elem,
        schema_load_metric_elem,
        schema_db_filter_button_elem,
        schema_search_elem
    ]) {
        element.disabled = disabled;
    }
    for (const input of schema_db_filter_menu_elem.querySelectorAll('input')) {
        input.disabled = disabled;
    }
    schema_reload_elem.title = disabled ? 'Loading schema' : 'Reload schema';
    schema_reload_elem.setAttribute('aria-label', disabled ? 'Loading schema' : 'Reload schema');
}

async function schemaFetch(query) {
    const connection = getCurrentSchemaConnection();
    const url = buildClickHouseUrl(connection.url.replace(/\/+$/, ''), connection.user, connection.password, 'JSONCompactEachRowWithNamesAndTypes');
    const response = await fetch(url, {
        method: 'POST',
        body: query,
        headers: { 'Authorization': 'never' }
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text || 'Schema query failed.');
    }

    const lines = text.split('\n').filter(line => line.length);
    if (lines.length < 2) {
        return { columns: [], types: [], rows: [] };
    }

    const columns = JSON.parse(lines[0]);
    const types = JSON.parse(lines[1]);
    const rows = [];
    for (let i = 2; i < lines.length; i++) {
        const values = JSON.parse(lines[i]);
        const row = {};
        for (let j = 0; j < columns.length; j++) {
            row[columns[j]] = values[j];
        }
        rows.push(row);
    }
    return { columns, types, rows };
}

async function getSchemaTargetMetadataSource() {
    const native_columns_query = `
        SELECT name
        FROM system.columns
        WHERE database = 'system'
          AND table = 'tables'
          AND name IN ('target_database', 'target_table')
    `;
    const native_columns = new Set((await schemaFetch(native_columns_query)).rows.map(row => row.name));
    if (native_columns.has('target_database') && native_columns.has('target_table')) {
        return { source: 'native', database: 'system' };
    }

    const saved_connection = getSavedConnections().find(connection => connection.id == current_connection_id);
    const compat_database = saved_connection?.schema_compat_database || 'system';
    const compat_database_literal = `'${String(compat_database).replace(/'/g, "''")}'`;

    const compat_columns_query = `
        SELECT name
        FROM system.columns
        WHERE database = ${compat_database_literal}
          AND table = 'schema_mv_targets'
          AND name IN ('database', 'name', 'target_database', 'target_table', 'updated_at')
    `;
    try {
        const compat_columns = new Set((await schemaFetch(compat_columns_query)).rows.map(row => row.name));
        if (compat_columns.has('database')
            && compat_columns.has('name')
            && compat_columns.has('target_database')
            && compat_columns.has('target_table')
            && compat_columns.has('updated_at')) {
            return { source: 'compat', database: compat_database };
        }
    } catch (error) {
        console.info('Schema MV target compatibility table check failed:', error.message);
    }

    return { source: 'missing', database: compat_database };
}

function schemaEngineKind(engine) {
    if (!engine) return 'other';
    if (engine == 'Dictionary') return 'dict';
    if (engine == 'Distributed') return 'distributed';
    if (engine == 'View' || engine == 'LiveView' || engine == 'WindowView') return 'view';
    if (engine == 'MaterializedView') return 'mv';
    if (String(engine).includes('MergeTree')) return 'mt';
    return 'other';
}

function schemaEngineAbbreviation(engine, kind) {
    if (kind == 'rmv') return 'rmv';

    const engine_name = String(engine || '').trim();
    const aliases = {
        MaterializedView: 'mv',
        Dictionary: 'dict',
        Distributed: 'dist',
        View: 'view',
        LiveView: 'live',
        WindowView: 'window'
    };
    if (aliases[engine_name]) return aliases[engine_name];

    const replicated = engine_name.startsWith('Replicated');
    const base_engine = replicated ? engine_name.slice('Replicated'.length) : engine_name;
    const merge_tree_aliases = {
        MergeTree: 'mt',
        ReplacingMergeTree: 'rmt',
        SummingMergeTree: 'smt',
        AggregatingMergeTree: 'amt',
        CollapsingMergeTree: 'cmt',
        VersionedCollapsingMergeTree: 'vcmt',
        CoalescingMergeTree: 'comt',
        GraphiteMergeTree: 'gmt'
    };
    if (merge_tree_aliases[base_engine]) {
        return `${replicated ? 'rep.' : ''}${merge_tree_aliases[base_engine]}`;
    }

    if (!engine_name) return '?';
    if (engine_name.length <= 8) return engine_name.toLowerCase();

    const abbreviation_source = base_engine.endsWith('MergeTree')
        ? base_engine.slice(0, -'MergeTree'.length)
        : engine_name;
    const words = abbreviation_source.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g) || [abbreviation_source];
    const merge_tree_suffix = base_engine.endsWith('MergeTree') ? 'mt' : '';
    const replication_prefix = replicated && merge_tree_suffix ? 'rep.' : '';
    return `${replication_prefix}${words.map(word => word[0].toLowerCase()).join('')}${merge_tree_suffix}`.slice(0, 8);
}

async function loadSchemaAll() {
    const generation = schema_view_state.generation;
    setSchemaControlsDisabled(true);
    schemaSetStatus('Loading tables...');

    const table_system_filter = schema_view_state.show_system
        ? ''
        : "WHERE st.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";
    const column_system_filter = schema_view_state.show_system
        ? ''
        : "WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

    let target_columns_sql = `
            st.target_database AS target_database,
            st.target_table AS target_table,`;
    let compat_join_sql = '';

    try {
        const target_metadata = await getSchemaTargetMetadataSource();
        schema_view_state.target_metadata_source = target_metadata.source;
        schema_view_state.target_metadata_database = target_metadata.database;
    } catch (error) {
        console.info('Schema target metadata source check failed:', error.message);
        schema_view_state.target_metadata_source = 'missing';
        const saved_connection = getSavedConnections().find(connection => connection.id == current_connection_id);
        schema_view_state.target_metadata_database = saved_connection?.schema_compat_database || 'system';
    }

    if (schema_view_state.target_metadata_source == 'compat') {
        target_columns_sql = `
            compat.target_database AS target_database,
            compat.target_table AS target_table,`;
        compat_join_sql = `
        LEFT JOIN
        (
            SELECT
                database,
                name,
                argMax(target_database, updated_at) AS target_database,
                argMax(target_table, updated_at) AS target_table
            FROM ${formatQualifiedIdentifier(schema_view_state.target_metadata_database, 'schema_mv_targets')}
            GROUP BY database, name
        ) AS compat
               ON compat.database = st.database AND compat.name = st.name`;
    } else if (schema_view_state.target_metadata_source == 'missing') {
        target_columns_sql = `
            '' AS target_database,
            '' AS target_table,`;
    }

    const tables_query = `
        SELECT
            st.database AS database,
            st.name AS name,
            st.engine AS engine,
            st.engine_full AS engine_full,
            st.create_table_query AS create_table_query,
            st.sorting_key AS sorting_key,
            st.primary_key AS primary_key,
            st.partition_key AS partition_key,
            st.sampling_key AS sampling_key,
            st.total_rows AS total_rows,
            st.total_bytes AS total_bytes,
            st.comment AS comment,
            ${target_columns_sql}
            arrayMap((d, tbl) -> concat(d, '.', tbl), st.dependencies_database, st.dependencies_table) AS dependents,
            arrayMap((d, tbl) -> concat(d, '.', tbl), st.loading_dependencies_database, st.loading_dependencies_table) AS depends_on
        FROM system.tables AS st
        ${compat_join_sql}
        ${table_system_filter}
        ORDER BY st.database, st.name
    `;

    const columns_query = `
        SELECT database, table, name, type,
               (is_in_primary_key OR is_in_sorting_key) AS is_key,
               default_kind != '' AS has_default
        FROM system.columns
        ${column_system_filter}
        ORDER BY database, table, position
    `;

    const dictionaries_query = `
        SELECT database, name, source
        FROM system.dictionaries
        WHERE status = 'LOADED' OR status = 'NOT_LOADED' OR status = 'LOADING'
    `;

    const refreshes_query = `
        SELECT database, view, status, last_success_time, next_refresh_time, exception
        FROM system.view_refreshes
    `;

    try {
        const tables_result = await schemaFetch(tables_query);
        let columns_result = { rows: [] };
        let dictionaries_result = { rows: [] };
        let refreshes_result = { rows: [] };
        try { columns_result = await schemaFetch(columns_query); } catch (e) { console.warn(e); }
        try { dictionaries_result = await schemaFetch(dictionaries_query); } catch (e) { console.warn(e); }
        try { refreshes_result = await schemaFetch(refreshes_query); } catch (e) { console.info('system.view_refreshes not available:', e.message); }

        if (generation != schema_view_state.generation) {
            return;
        }

        schema_view_state.tables = tables_result.rows;
        schema_view_state.columns_by_table = new Map();
        for (const column of columns_result.rows) {
            const key = schemaFullName(column.database, column.table);
            if (!schema_view_state.columns_by_table.has(key)) {
                schema_view_state.columns_by_table.set(key, []);
            }
            schema_view_state.columns_by_table.get(key).push(column);
        }

        schema_view_state.dict_sources = new Map();
        for (const dictionary of dictionaries_result.rows) {
            schema_view_state.dict_sources.set(schemaFullName(dictionary.database, dictionary.name), dictionary.source);
        }

        schema_view_state.refreshes = new Map();
        for (const refresh of refreshes_result.rows) {
            schema_view_state.refreshes.set(schemaFullName(refresh.database, refresh.view), refresh);
        }

        schemaSetStatus(getSchemaLoadedStatus(columns_result.rows.length));
        buildSchemaGraph();
        updateSchemaDbFilter();
        await loadSchemaViewsLoad();
        schemaRender();
    } catch (error) {
        console.log(error);
        schemaSetStatus(`Failed: ${error.message || error.toString()}`, true);
    } finally {
        setSchemaControlsDisabled(false);
    }
}

function getSchemaLoadedStatus(column_count = null) {
    const columns = column_count == null ? '' : `, ${column_count} columns`;
    let suffix = '';
    if (schema_view_state.target_metadata_source == 'compat') {
        suffix = ` MV targets: ${schemaFullName(schema_view_state.target_metadata_database, 'schema_mv_targets')}.`;
    } else if (schema_view_state.target_metadata_source == 'missing') {
        suffix = ` MV targets unavailable: ${schemaFullName(schema_view_state.target_metadata_database, 'schema_mv_targets')}.`;
    }
    return `Loaded ${schema_view_state.tables.length} tables${columns}.${suffix}`;
}

async function loadSchemaViewsLoad() {
    schema_view_state.load_by_mv = new Map();
    schema_view_state.load_by_edge = new Map();
    schema_view_state.load_max = { by_mv: {}, by_edge: {} };

    const days = Number(schema_view_state.load_period_days || 0);
    if (!days || !schema_view_state.nodes.size) {
        return;
    }

    const quoted_to_key = new Map();
    for (const node of schema_view_state.nodes.values()) {
        quoted_to_key.set(schemaQuotedFullName(node.database, node.name), node.key);
    }

    const query = `
        SELECT
            view_name,
            view_target,
            count() AS executions,
            sum(view_duration_ms) AS total_duration_ms,
            sum(read_rows) AS read_rows,
            sum(read_bytes) AS read_bytes,
            sum(written_rows) AS written_rows,
            sum(written_bytes) AS written_bytes,
            sum(peak_memory_usage) AS peak_memory_usage
        FROM system.query_views_log
        WHERE event_date >= today() - INTERVAL ${days} DAY
          AND status IN ('QueryFinish', 'ExceptionWhileProcessing')
        GROUP BY view_name, view_target
    `;

    let rows;
    try {
        rows = (await schemaFetch(query)).rows;
    } catch (error) {
        console.info('system.query_views_log not available:', error.message);
        schemaSetStatus(`${getSchemaLoadedStatus()} ${schema_view_state.nodes.size} nodes (query_views_log unavailable).`);
        return;
    }

    const metric_keys = ['executions', 'total_duration_ms', 'read_rows', 'read_bytes', 'written_rows', 'written_bytes', 'peak_memory_usage'];
    const max_by_mv = {};
    const max_by_edge = {};
    for (const metric of metric_keys) {
        max_by_mv[metric] = 0;
        max_by_edge[metric] = 0;
    }

    let matched = 0;
    for (const row of rows) {
        const mv_key = quoted_to_key.get(row.view_name);
        if (!mv_key) {
            continue;
        }
        matched++;
        const target_key = row.view_target ? quoted_to_key.get(row.view_target) : null;
        const mv_metrics = schema_view_state.load_by_mv.get(mv_key) || makeSchemaMetrics();
        for (const metric of metric_keys) {
            mv_metrics[metric] += Number(row[metric]) || 0;
            max_by_mv[metric] = Math.max(max_by_mv[metric], mv_metrics[metric]);
        }
        schema_view_state.load_by_mv.set(mv_key, mv_metrics);

        if (target_key) {
            const edge_key = `${mv_key}\x00${target_key}`;
            const edge_metrics = schema_view_state.load_by_edge.get(edge_key) || makeSchemaMetrics();
            for (const metric of metric_keys) {
                edge_metrics[metric] += Number(row[metric]) || 0;
                max_by_edge[metric] = Math.max(max_by_edge[metric], edge_metrics[metric]);
            }
            schema_view_state.load_by_edge.set(edge_key, edge_metrics);
        }
    }

    schema_view_state.load_max = { by_mv: max_by_mv, by_edge: max_by_edge };
    schemaSetStatus(`${getSchemaLoadedStatus()} ${schema_view_state.nodes.size} nodes. INSERT load: ${matched}/${rows.length} rows over ${days}d.`);
}

function makeSchemaMetrics() {
    return {
        executions: 0,
        total_duration_ms: 0,
        read_rows: 0,
        read_bytes: 0,
        written_rows: 0,
        written_bytes: 0,
        peak_memory_usage: 0
    };
}

function schemaLoadColour(intensity) {
    intensity = Math.max(0, Math.min(1, intensity));
    const stops = [
        { p: 0.00, r: 0x2a, g: 0x4d, b: 0x8a },
        { p: 0.33, r: 0x6a, g: 0xa8, b: 0x4f },
        { p: 0.66, r: 0xf1, g: 0xc2, b: 0x32 },
        { p: 1.00, r: 0xcc, g: 0x00, b: 0x00 }
    ];
    let i = 0;
    while (i < stops.length - 1 && intensity > stops[i + 1].p) {
        i++;
    }
    const a = stops[i];
    const b = stops[i + 1] || stops[i];
    const t = b.p == a.p ? 0 : (intensity - a.p) / (b.p - a.p);
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    return `rgb(${r}, ${g}, ${bl})`;
}

function schemaLoadIntensity(value, max) {
    if (!value || !max || max <= 0) return 0;
    if (max == value) return 1;
    return Math.log1p(value) / Math.log1p(max);
}

function buildSchemaGraph() {
    const nodes = new Map();
    const nodes_by_db = new Map();
    for (const table of schema_view_state.tables) {
        const key = schemaFullName(table.database, table.name);
        const is_refreshable = schema_view_state.refreshes.has(key);
        const kind = is_refreshable ? 'rmv' : schemaEngineKind(table.engine);
        const node = {
            key,
            database: table.database,
            name: table.name,
            engine: table.engine,
            engine_full: table.engine_full,
            kind,
            create_query: table.create_table_query,
            sorting_key: table.sorting_key,
            primary_key: table.primary_key,
            partition_key: table.partition_key,
            sampling_key: table.sampling_key,
            total_rows: table.total_rows,
            total_bytes: table.total_bytes,
            comment: table.comment,
            target_database: table.target_database || '',
            target_table: table.target_table || '',
            dependents: table.dependents || [],
            depends_on: table.depends_on || [],
            columns: schema_view_state.columns_by_table.get(key) || [],
            dict_source: schema_view_state.dict_sources.get(key),
            refresh: schema_view_state.refreshes.get(key),
            x: 0,
            y: 0,
            w: 0,
            h: 0
        };
        nodes.set(key, node);
        if (!nodes_by_db.has(table.database)) {
            nodes_by_db.set(table.database, []);
        }
        nodes_by_db.get(table.database).push(node);
    }

    const edges = [];
    const seen = new Set();
    function addEdge(from, to, kind) {
        if (!nodes.has(from) || !nodes.has(to) || from == to) return;
        const key = `${from}\x00${to}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({ from, to, kind });
    }

    for (const node of nodes.values()) {
        const is_mv = node.kind == 'mv' || node.kind == 'rmv';
        for (const dependency of node.depends_on) {
            if (is_mv) addEdge(dependency, node.key, 'mv');
            else if (node.kind == 'dict') addEdge(dependency, node.key, 'dict');
            else if (node.kind == 'distributed') addEdge(dependency, node.key, 'distributed');
            else addEdge(dependency, node.key, 'normal');
        }
        for (const dependency of node.dependents) {
            const dependency_node = nodes.get(dependency);
            if (is_mv) addEdge(node.key, dependency, 'mv');
            else if (dependency_node && (dependency_node.kind == 'mv' || dependency_node.kind == 'rmv')) addEdge(node.key, dependency, 'mv');
            else if (dependency_node && dependency_node.kind == 'dict') addEdge(node.key, dependency, 'dict');
            else if (dependency_node && dependency_node.kind == 'distributed') addEdge(node.key, dependency, 'distributed');
            else addEdge(node.key, dependency, 'normal');
        }
        if (is_mv && node.target_table) {
            addEdge(node.key, schemaFullName(node.target_database || node.database, node.target_table), 'mv');
        }
    }

    schema_view_state.nodes = nodes;
    schema_view_state.nodes_by_db = nodes_by_db;
    schema_view_state.edges = edges;
}

function updateSchemaDbFilter() {
    const previous = new Set(schema_view_state.selected_databases);
    schema_db_filter_menu_elem.innerHTML = '';
    const databases = Array.from(schema_view_state.nodes_by_db.keys()).sort();
    schema_view_state.selected_databases = new Set([...previous].filter(database => databases.includes(database)));

    const all_label = document.createElement('label');
    all_label.className = 'schema-multiselect-option';
    const all_input = document.createElement('input');
    all_input.type = 'checkbox';
    all_input.checked = schema_view_state.selected_databases.size == 0;
    all_input.addEventListener('change', () => {
        schema_view_state.selected_databases.clear();
        updateSchemaDbFilter();
        schemaRender();
    });
    all_label.append(all_input, document.createTextNode('All databases'));
    schema_db_filter_menu_elem.appendChild(all_label);

    for (const database of databases) {
        const label = document.createElement('label');
        label.className = 'schema-multiselect-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = database;
        input.checked = schema_view_state.selected_databases.has(database);
        input.addEventListener('change', () => {
            if (input.checked) {
                schema_view_state.selected_databases.add(database);
            } else {
                schema_view_state.selected_databases.delete(database);
            }
            updateSchemaDbFilter();
            schemaRender();
        });
        label.append(input, document.createTextNode(`${database} (${schema_view_state.nodes_by_db.get(database).length})`));
        schema_db_filter_menu_elem.appendChild(label);
    }
    updateSchemaDbFilterButton();
}

function updateSchemaDbFilterButton() {
    const selected = [...schema_view_state.selected_databases].sort();
    let label = 'All databases';
    if (selected.length == 1) {
        label = selected[0];
    } else if (selected.length > 1) {
        label = `${selected.length} databases`;
    }
    schema_db_filter_button_elem.textContent = label;
    schema_db_filter_button_elem.title = selected.length ? selected.join(', ') : 'All databases';
}

function closeSchemaDbFilterMenu() {
    schema_db_filter_menu_elem.hidden = true;
    schema_db_filter_button_elem.setAttribute('aria-expanded', 'false');
}

function isSchemaDatabaseVisible(database) {
    return schema_view_state.selected_databases.size == 0 || schema_view_state.selected_databases.has(database);
}

function layoutSchemaDatabase(database_nodes, edges) {
    const in_database = new Set(database_nodes.map(node => node.key));
    const outgoing = new Map();
    const incoming = new Map();
    for (const node of database_nodes) {
        outgoing.set(node.key, []);
        incoming.set(node.key, []);
    }
    for (const edge of edges) {
        if (in_database.has(edge.from) && in_database.has(edge.to)) {
            outgoing.get(edge.from).push(edge.to);
            incoming.get(edge.to).push(edge.from);
        }
    }

    const depth = new Map();
    const visiting = new Set();
    function dfs(key, stack) {
        if (depth.has(key)) return depth.get(key);
        if (visiting.has(key)) return 0;
        visiting.add(key);
        let result = 0;
        for (const upstream of incoming.get(key) || []) {
            if (stack.has(upstream)) continue;
            stack.add(upstream);
            result = Math.max(result, dfs(upstream, stack) + 1);
            stack.delete(upstream);
        }
        visiting.delete(key);
        depth.set(key, result);
        return result;
    }

    for (const node of database_nodes) {
        dfs(node.key, new Set([node.key]));
    }

    const layers = new Map();
    let max_depth = 0;
    for (const node of database_nodes) {
        const d = depth.get(node.key) || 0;
        if (!layers.has(d)) {
            layers.set(d, []);
        }
        layers.get(d).push(node);
        max_depth = Math.max(max_depth, d);
    }

    for (const layer of layers.values()) {
        layer.sort((a, b) => a.name.localeCompare(b.name));
    }

    for (let iter = 0; iter < 8; iter++) {
        for (let d = 1; d <= max_depth; d++) {
            const layer = layers.get(d) || [];
            const previous = layers.get(d - 1) || [];
            const previous_index = new Map();
            previous.forEach((node, index) => previous_index.set(node.key, index));
            for (const node of layer) {
                const inputs = (incoming.get(node.key) || []).filter(key => previous_index.has(key)).map(key => previous_index.get(key));
                node._bary = inputs.length ? inputs.reduce((a, b) => a + b, 0) / inputs.length : previous_index.size / 2;
            }
            layer.sort((a, b) => (a._bary - b._bary) || a.name.localeCompare(b.name));
        }
        for (let d = max_depth - 1; d >= 0; d--) {
            const layer = layers.get(d) || [];
            const next = layers.get(d + 1) || [];
            const next_index = new Map();
            next.forEach((node, index) => next_index.set(node.key, index));
            for (const node of layer) {
                const outputs = (outgoing.get(node.key) || []).filter(key => next_index.has(key)).map(key => next_index.get(key));
                node._bary = outputs.length ? outputs.reduce((a, b) => a + b, 0) / outputs.length : next_index.size / 2;
            }
            layer.sort((a, b) => (a._bary - b._bary) || a.name.localeCompare(b.name));
        }
    }

    return { layers, max_depth };
}

function schemaNodeMatchesSearch(node, search) {
    return !search
        || node.key.toLowerCase().includes(search)
        || node.name.toLowerCase().includes(search)
        || node.columns.some(column => String(column.name).toLowerCase().includes(search));
}

function getVisibleSchemaNodeKeys() {
    const search = schema_search_elem.value.trim().toLowerCase();
    const visible = new Set();
    for (const node of schema_view_state.nodes.values()) {
        if (isSchemaDatabaseVisible(node.database) && schemaNodeMatchesSearch(node, search)) {
            visible.add(node.key);
        }
    }
    return visible;
}

function estimateSchemaNodeSize(node) {
    const column_count = schema_view_state.show_columns ? Math.min(node.columns.length, 14) : 0;
    return {
        w: 280,
        h: 42 + column_count * 20 + (node.total_rows != null && node.total_rows !== '0' ? 24 : 0)
    };
}

function layoutSchemaAll(visible_node_keys = getVisibleSchemaNodeKeys()) {
    const visible_databases = Array.from(schema_view_state.nodes_by_db.keys())
        .filter(database => isSchemaDatabaseVisible(database))
        .filter(database => (schema_view_state.nodes_by_db.get(database) || []).some(node => visible_node_keys.has(node.key)))
        .sort();
    const layer_width = 370;
    const node_gap_x = 120;
    const node_gap_y = 44;
    const db_padding = 54;
    const db_padding_top = 68;
    const db_gap = 100;

    for (const node of schema_view_state.nodes.values()) {
        const size = estimateSchemaNodeSize(node);
        node.w = size.w;
        node.h = size.h;
    }

    const sections = [];
    for (const database of visible_databases) {
        const database_nodes = (schema_view_state.nodes_by_db.get(database) || [])
            .filter(node => visible_node_keys.has(node.key));
        const { layers, max_depth } = layoutSchemaDatabase(database_nodes, schema_view_state.edges);
        const layer_heights = new Map();
        for (let d = 0; d <= max_depth; d++) {
            const layer = layers.get(d) || [];
            let y = 0;
            for (const node of layer) {
                node._rx = d * (layer_width + node_gap_x);
                node._ry = y;
                y += node.h + node_gap_y;
            }
            layer_heights.set(d, y);
        }
        const section_width = Math.max(0, (max_depth + 1) * layer_width + max_depth * node_gap_x);
        const section_height = Math.max(...Array.from(layer_heights.values()), 0);
        sections.push({
            database,
            nodes: database_nodes,
            w: section_width + db_padding * 2,
            h: section_height + db_padding_top + db_padding
        });
    }

    const margin = 36;
    const viewport_width = schema_viewport_elem.clientWidth - margin * 2;
    let cursor_x = margin;
    let cursor_y = margin;
    let row_height = 0;
    for (const section of sections) {
        if (cursor_x > margin && cursor_x + section.w > viewport_width + margin) {
            cursor_x = margin;
            cursor_y += row_height + db_gap;
            row_height = 0;
        }
        section.x = cursor_x;
        section.y = cursor_y;
        for (const node of section.nodes) {
            node.x = cursor_x + db_padding + (node._rx || 0);
            node.y = cursor_y + db_padding_top + (node._ry || 0);
        }
        cursor_x += section.w + db_gap;
        row_height = Math.max(row_height, section.h);
    }
    schema_view_state.sections = sections;
}

function formatSchemaBytes(value) {
    if (value == null) return '';
    let n = Number(value);
    if (!Number.isFinite(n) || n == 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${n.toFixed(n < 10 ? 2 : (n < 100 ? 1 : 0))} ${units[unit]}`;
}

function formatSchemaRows(value) {
    if (value == null) return '';
    const n = Number(value);
    if (!Number.isFinite(n) || n == 0) return '';
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
    return String(n);
}

function formatSchemaMs(value) {
    const n = Number(value) || 0;
    if (n < 1000) return `${n.toFixed(0)} ms`;
    if (n < 60000) return `${(n / 1000).toFixed(2)} s`;
    if (n < 3600000) return `${(n / 60000).toFixed(2)} min`;
    return `${(n / 3600000).toFixed(2)} h`;
}

function formatSchemaLoadValue(metric, value) {
    switch (metric) {
        case 'written_bytes':
        case 'read_bytes':
        case 'peak_memory_usage':
            return formatSchemaBytes(value);
        case 'total_duration_ms':
            return formatSchemaMs(value);
        case 'executions':
            return String(Math.round(Number(value) || 0));
        default:
            return formatSchemaRows(value);
    }
}

function schemaRender() {
    schema_canvas_elem.querySelectorAll('.schema-node, .schema-db-group').forEach(element => element.remove());
    if (!schema_view_state.tables.length) {
        setSchemaEmptyMessage('Load the schema for this connection.', 'Click a node to inspect it. Drag a node to reposition it.');
        schema_empty_elem.classList.remove('hidden');
        schema_links_svg_elem.innerHTML = '';
        return;
    }

    const visible_node_keys = getVisibleSchemaNodeKeys();
    if (!visible_node_keys.size) {
        setSchemaEmptyMessage('No schema objects matched.', 'Adjust the database selection or search filter.');
        schema_empty_elem.classList.remove('hidden');
        schema_links_svg_elem.innerHTML = '';
        schema_canvas_elem.style.width = '100%';
        schema_canvas_elem.style.height = '100%';
        schema_links_svg_elem.setAttribute('width', 0);
        schema_links_svg_elem.setAttribute('height', 0);
        return;
    }
    schema_empty_elem.classList.add('hidden');

    layoutSchemaAll(visible_node_keys);

    let max_x = 0;
    let max_y = 0;
    for (const section of schema_view_state.sections) {
        const group = document.createElement('div');
        group.className = 'schema-db-group';
        group.style.left = `${section.x}px`;
        group.style.top = `${section.y}px`;
        group.style.width = `${section.w}px`;
        group.style.height = `${section.h}px`;
        const label = document.createElement('div');
        label.className = 'schema-db-label';
        label.textContent = section.database;
        group.appendChild(label);
        schema_canvas_elem.appendChild(group);
    }

    for (const node of schema_view_state.nodes.values()) {
        if (!visible_node_keys.has(node.key)) continue;
        if (!node.w) continue;
        const element = document.createElement('div');
        element.className = `schema-node schema-node-${node.kind}`;
        element.dataset.key = node.key;
        element.style.left = `${node.x}px`;
        element.style.top = `${node.y}px`;
        element.style.width = `${node.w}px`;
        if (schema_view_state.selected_key == node.key) element.classList.add('selected');

        const header = document.createElement('div');
        header.className = 'schema-node-header';
        const name = document.createElement('span');
        name.className = 'schema-node-name';
        name.title = node.key;
        name.textContent = node.name;
        const kind = document.createElement('span');
        kind.className = 'schema-node-kind';
        kind.textContent = schemaEngineAbbreviation(node.engine, node.kind);
        kind.title = node.kind == 'rmv' ? 'Refreshable MaterializedView' : (node.engine || 'Unknown engine');
        header.append(name, kind);

        const mv_load = schema_view_state.load_by_mv.get(node.key);
        if (mv_load && schema_view_state.load_period_days) {
            const metric = schema_view_state.load_metric;
            const value = mv_load[metric] || 0;
            const max = schema_view_state.load_max.by_mv[metric] || 0;
            if (value > 0) {
                const badge = document.createElement('span');
                badge.className = 'schema-load-badge';
                badge.title = `INSERT pipeline load (${metric}) over last ${schema_view_state.load_period_days}d`;
                badge.style.background = schemaLoadColour(schemaLoadIntensity(value, max));
                badge.textContent = formatSchemaLoadValue(metric, value);
                header.appendChild(badge);
            }
        }
        element.appendChild(header);

        if (schema_view_state.show_columns && node.columns.length) {
            const columns = document.createElement('div');
            columns.className = 'schema-node-columns';
            const shown_columns = node.columns.slice(0, 14);
            for (const column of shown_columns) {
                const row = document.createElement('div');
                row.className = 'schema-column';
                const column_name = document.createElement('span');
                column_name.className = 'schema-column-name';
                if (column.is_key === 1 || column.is_key === true) column_name.classList.add('key');
                else if (column.has_default === 1 || column.has_default === true) column_name.classList.add('default');
                column_name.textContent = column.name;
                const column_type = document.createElement('span');
                column_type.className = 'schema-column-type';
                column_type.title = column.type;
                column_type.textContent = column.type;
                row.append(column_name, column_type);
                columns.appendChild(row);
            }
            if (node.columns.length > shown_columns.length) {
                const more = document.createElement('div');
                more.className = 'schema-column';
                more.style.color = 'var(--schema-muted)';
                more.style.fontStyle = 'italic';
                more.textContent = `... ${node.columns.length - shown_columns.length} more`;
                columns.appendChild(more);
            }
            element.appendChild(columns);
        }

        if (node.total_rows && Number(node.total_rows) > 0) {
            const stats = document.createElement('div');
            stats.className = 'schema-node-stats';
            const rows = document.createElement('span');
            rows.textContent = `${formatSchemaRows(node.total_rows)} rows`;
            const bytes = document.createElement('span');
            bytes.textContent = formatSchemaBytes(node.total_bytes);
            stats.append(rows, bytes);
            element.appendChild(stats);
        }

        element.addEventListener('click', event => {
            event.stopPropagation();
            selectSchemaNode(node.key);
        });
        attachSchemaDrag(element, node);
        schema_canvas_elem.appendChild(element);
        max_x = Math.max(max_x, node.x + node.w);
        max_y = Math.max(max_y, node.y + node.h);
    }

    for (const element of schema_canvas_elem.querySelectorAll('.schema-node')) {
        const node = schema_view_state.nodes.get(element.dataset.key);
        if (node) {
            node.h = element.offsetHeight;
            node.w = element.offsetWidth;
            max_x = Math.max(max_x, node.x + node.w);
            max_y = Math.max(max_y, node.y + node.h);
        }
    }

    for (const group of schema_canvas_elem.querySelectorAll('.schema-db-group')) {
        const label = group.querySelector('.schema-db-label').textContent;
        let mx = 0;
        let my = 0;
        const sx = parseFloat(group.style.left);
        const sy = parseFloat(group.style.top);
        for (const node of schema_view_state.nodes_by_db.get(label) || []) {
            if (!visible_node_keys.has(node.key)) continue;
            mx = Math.max(mx, node.x + node.w - sx);
            my = Math.max(my, node.y + node.h - sy);
        }
        group.style.width = `${mx + 24}px`;
        group.style.height = `${my + 24}px`;
    }

    drawSchemaEdges(visible_node_keys);
    schema_canvas_elem.style.width = `${max_x + 60}px`;
    schema_canvas_elem.style.height = `${max_y + 60}px`;
    schema_links_svg_elem.setAttribute('width', max_x + 60);
    schema_links_svg_elem.setAttribute('height', max_y + 60);
}

function drawSchemaEdges(visible = getVisibleSchemaNodeKeys()) {
    schema_links_svg_elem.innerHTML = '';

    const incoming = new Map();
    const outgoing = new Map();
    for (const edge of schema_view_state.edges) {
        if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
        if (!incoming.has(edge.to)) incoming.set(edge.to, []);
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
        incoming.get(edge.to).push(edge.from);
        outgoing.get(edge.from).push(edge.to);
    }
    schema_view_state._incoming = incoming;
    schema_view_state._outgoing = outgoing;

    const metric = schema_view_state.load_metric;
    const edge_max = schema_view_state.load_max.by_edge[metric] || 0;

    for (const edge of schema_view_state.edges) {
        if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
        const source = schema_view_state.nodes.get(edge.from);
        const target = schema_view_state.nodes.get(edge.to);
        if (!source || !target) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const kind_class = edge.kind == 'normal' ? '' : edge.kind;
        path.setAttribute('class', `schema-arrow ${kind_class}`);
        path.setAttribute('data-from', edge.from);
        path.setAttribute('data-to', edge.to);

        const x1 = source.x + source.w;
        const y1 = source.y + source.h / 2;
        const x2 = target.x;
        const y2 = target.y + target.h / 2;
        const dx = Math.max(40, (x2 - x1) / 2);
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 8} ${y2}`);

        let arrow_colour = null;
        if (schema_view_state.load_period_days && edge_max > 0) {
            const edge_load = schema_view_state.load_by_edge.get(`${edge.from}\x00${edge.to}`);
            if (edge_load) {
                const value = edge_load[metric] || 0;
                if (value > 0) {
                    const intensity = schemaLoadIntensity(value, edge_max);
                    arrow_colour = schemaLoadColour(intensity);
                    path.setAttribute('stroke', arrow_colour);
                    path.setAttribute('stroke-width', String(1.5 + 3 * intensity));
                    path.style.opacity = String(0.55 + 0.45 * intensity);
                    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                    title.textContent = `${edge.from} -> ${edge.to}\n${metric} = ${formatSchemaLoadValue(metric, value)} over last ${schema_view_state.load_period_days}d`;
                    path.appendChild(title);
                }
            }
        }

        schema_links_svg_elem.appendChild(path);
        const arrowhead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrowhead.setAttribute('class', `schema-arrowhead ${kind_class}`);
        arrowhead.setAttribute('data-from', edge.from);
        arrowhead.setAttribute('data-to', edge.to);
        const angle = Math.atan2(y2 - y1, (x2 - 8) - (x1 + dx));
        const hx = x2 - 4;
        const hy = y2;
        const len = 8;
        const spread = 4;
        const p1x = hx - len * Math.cos(angle) + spread * Math.sin(angle);
        const p1y = hy - len * Math.sin(angle) - spread * Math.cos(angle);
        const p2x = hx - len * Math.cos(angle) - spread * Math.sin(angle);
        const p2y = hy - len * Math.sin(angle) + spread * Math.cos(angle);
        arrowhead.setAttribute('points', `${hx},${hy} ${p1x},${p1y} ${p2x},${p2y}`);
        if (arrow_colour) {
            arrowhead.setAttribute('fill', arrow_colour);
            arrowhead.setAttribute('stroke', arrow_colour);
        }
        schema_links_svg_elem.appendChild(arrowhead);
    }
}

function highlightSchemaSelection(key) {
    const incoming = schema_view_state._incoming?.get(key) || [];
    const outgoing = schema_view_state._outgoing?.get(key) || [];
    const relevant = new Set([key, ...incoming, ...outgoing]);
    for (const element of schema_canvas_elem.querySelectorAll('.schema-node')) {
        element.classList.remove('highlighted', 'dimmed', 'selected');
        if (element.dataset.key == key) element.classList.add('selected');
        else if (relevant.has(element.dataset.key)) element.classList.add('highlighted');
        else element.classList.add('dimmed');
    }
    for (const element of schema_links_svg_elem.querySelectorAll('.schema-arrow, .schema-arrowhead')) {
        element.classList.remove('highlighted', 'dimmed');
        const from = element.getAttribute('data-from');
        const to = element.getAttribute('data-to');
        if (from == key || to == key) element.classList.add('highlighted');
        else element.classList.add('dimmed');
    }
}

function clearSchemaHighlight() {
    for (const element of schema_canvas_elem.querySelectorAll('.schema-node')) {
        element.classList.remove('highlighted', 'dimmed', 'selected');
    }
    for (const element of schema_links_svg_elem.querySelectorAll('.schema-arrow, .schema-arrowhead')) {
        element.classList.remove('highlighted', 'dimmed');
    }
    schema_view_state.selected_key = null;
    schema_sidebar_elem.classList.remove('open');
}

function selectSchemaNode(key) {
    schema_view_state.selected_key = key;
    highlightSchemaSelection(key);
    showSchemaSidebar(key);
}

function appendSchemaDetailsRow(table, key, value) {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = key;
    const content = document.createElement('td');
    content.textContent = value == null ? '' : String(value);
    tr.append(label, content);
    table.appendChild(tr);
}

function showSchemaSidebar(key) {
    const node = schema_view_state.nodes.get(key);
    if (!node) return;
    schema_sidebar_title_elem.textContent = node.key;
    schema_sidebar_content_elem.innerHTML = '';

    const table = document.createElement('table');
    const rows = [
        ['Database', node.database],
        ['Name', node.name],
        ['Engine', node.engine_full || node.engine]
    ];
    if (node.partition_key) rows.push(['Partition by', node.partition_key]);
    if (node.sorting_key) rows.push(['Order by', node.sorting_key]);
    if (node.primary_key && node.primary_key != node.sorting_key) rows.push(['Primary key', node.primary_key]);
    if (node.sampling_key) rows.push(['Sample by', node.sampling_key]);
    if (node.total_rows && Number(node.total_rows) > 0) rows.push(['Rows', formatSchemaRows(node.total_rows)]);
    if (node.total_bytes && Number(node.total_bytes) > 0) rows.push(['Bytes', formatSchemaBytes(node.total_bytes)]);
    if (node.comment) rows.push(['Comment', node.comment]);
    if (node.refresh) {
        rows.push(['Refresh status', node.refresh.status]);
        if (node.refresh.last_success_time) rows.push(['Last refresh', node.refresh.last_success_time]);
        if (node.refresh.next_refresh_time) rows.push(['Next refresh', node.refresh.next_refresh_time]);
        if (node.refresh.exception) rows.push(['Refresh error', node.refresh.exception]);
    }
    if (node.dict_source) rows.push(['Dictionary source', node.dict_source]);
    const mv_load = schema_view_state.load_by_mv.get(node.key);
    if (mv_load && schema_view_state.load_period_days) {
        rows.push([`INSERT load (last ${schema_view_state.load_period_days}d)`, '']);
        rows.push(['  Executions', formatSchemaLoadValue('executions', mv_load.executions)]);
        rows.push(['  Rows written', formatSchemaLoadValue('written_rows', mv_load.written_rows)]);
        rows.push(['  Bytes written', formatSchemaLoadValue('written_bytes', mv_load.written_bytes)]);
        rows.push(['  Rows read', formatSchemaLoadValue('read_rows', mv_load.read_rows)]);
        rows.push(['  Bytes read', formatSchemaLoadValue('read_bytes', mv_load.read_bytes)]);
        rows.push(['  Total view duration', formatSchemaLoadValue('total_duration_ms', mv_load.total_duration_ms)]);
        rows.push(['  Peak memory (sum)', formatSchemaLoadValue('peak_memory_usage', mv_load.peak_memory_usage)]);
    }
    for (const [row_key, row_value] of rows) {
        appendSchemaDetailsRow(table, row_key, row_value);
    }
    schema_sidebar_content_elem.appendChild(table);

    if (node.columns.length) {
        const heading = document.createElement('h3');
        heading.textContent = `Columns (${node.columns.length})`;
        schema_sidebar_content_elem.appendChild(heading);
        const columns_table = document.createElement('table');
        for (const column of node.columns) {
            const tr = document.createElement('tr');
            const name = document.createElement('td');
            name.textContent = column.name;
            if (column.is_key === 1 || column.is_key === true) name.style.color = 'var(--schema-column-key)';
            const type = document.createElement('td');
            type.textContent = column.type;
            type.style.color = 'var(--schema-muted)';
            type.style.whiteSpace = 'normal';
            type.style.wordBreak = 'break-word';
            tr.append(name, type);
            columns_table.appendChild(tr);
        }
        schema_sidebar_content_elem.appendChild(columns_table);
    }

    appendSchemaRelatedLinks('Reads from', schema_view_state._incoming?.get(key) || []);
    appendSchemaRelatedLinks('Writes to / depended on by', schema_view_state._outgoing?.get(key) || []);

    if (node.create_query) {
        const heading = document.createElement('h3');
        heading.textContent = 'CREATE statement';
        const pre = document.createElement('pre');
        pre.textContent = node.create_query;
        schema_sidebar_content_elem.append(heading, pre);
    }

    schema_sidebar_elem.classList.add('open');
}

function appendSchemaRelatedLinks(label, keys) {
    if (!keys.length) return;
    const heading = document.createElement('h3');
    heading.textContent = `${label} (${keys.length})`;
    const wrapper = document.createElement('div');
    wrapper.className = 'schema-related-table';
    for (const key of keys) {
        const link = document.createElement('a');
        link.textContent = key;
        link.addEventListener('click', () => selectSchemaNode(key));
        wrapper.appendChild(link);
    }
    schema_sidebar_content_elem.append(heading, wrapper);
}

function attachSchemaDrag(element, node) {
    let start_x;
    let start_y;
    let original_x;
    let original_y;
    let dragging = false;
    element.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        dragging = false;
        start_x = event.clientX;
        start_y = event.clientY;
        original_x = node.x;
        original_y = node.y;
        const onMove = move_event => {
            const dx = (move_event.clientX - start_x) / schema_view_state.zoom;
            const dy = (move_event.clientY - start_y) / schema_view_state.zoom;
            if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) {
                dragging = true;
            }
            if (!dragging) return;
            node.x = original_x + dx;
            node.y = original_y + dy;
            element.style.left = `${node.x}px`;
            element.style.top = `${node.y}px`;
            drawSchemaEdges();
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (dragging) {
                const stopClick = click_event => {
                    click_event.stopPropagation();
                    element.removeEventListener('click', stopClick, true);
                };
                element.addEventListener('click', stopClick, true);
            }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}

function schemaApplyZoom() {
    schema_canvas_elem.style.transform = `scale(${schema_view_state.zoom})`;
}

function updateSchemaLoadLegendVisibility() {
    schema_load_legend_elem.hidden = !schema_view_state.load_period_days;
    if (schema_view_state.load_period_days) {
        schema_load_legend_label_elem.textContent =
            `INSERT pipeline load - ${schema_view_state.load_metric} (cool to hot, last ${schema_view_state.load_period_days}d)`;
    }
}

function redrawSchemaGraph() {
    if (current_workspace_view == 'schema' && schema_view_state.nodes.size) {
        schemaRender();
    }
}
