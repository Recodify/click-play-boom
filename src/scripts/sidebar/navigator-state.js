function getNavigatorDatabaseKey(connection_id, database_name) {
    return `${connection_id}:${database_name}`;
}

function getNavigatorGroupKey(connection_id, database_name, group_name) {
    return `${connection_id}:${database_name}:${group_name}`;
}

function getNavigatorTableKey(connection_id, database_name, table_name) {
    return `${connection_id}:${database_name}:${table_name}`;
}

function getSchemaTableKey(database_name, table_name) {
    return `${database_name}:${table_name}`;
}

function isConnectionExpanded(connection_id) {
    if (Object.prototype.hasOwnProperty.call(navigator_state.connections, connection_id)) {
        return !!navigator_state.connections[connection_id];
    }

    return connection_id == current_connection_id;
}

function setConnectionExpanded(connection_id, expanded) {
    navigator_state.connections[connection_id] = expanded;
    saveNavigatorState();
}

function isDatabaseExpanded(connection_id, database_name) {
    return !!navigator_state.databases[getNavigatorDatabaseKey(connection_id, database_name)];
}

function setDatabaseExpanded(connection_id, database_name, expanded) {
    const key = getNavigatorDatabaseKey(connection_id, database_name);
    if (expanded) {
        navigator_state.databases[key] = true;
    } else {
        delete navigator_state.databases[key];
    }
    saveNavigatorState();
}

function isSchemaGroupExpanded(connection_id, database_name, group_name) {
    const key = getNavigatorGroupKey(connection_id, database_name, group_name);
    if (Object.prototype.hasOwnProperty.call(navigator_state.groups, key)) {
        return !!navigator_state.groups[key];
    }

    return true;
}

function setSchemaGroupExpanded(connection_id, database_name, group_name, expanded) {
    const key = getNavigatorGroupKey(connection_id, database_name, group_name);
    navigator_state.groups[key] = !!expanded;
    saveNavigatorState();
}

function setAllConnectionDatabasesExpanded(connection, expanded) {
    if (!connection || schema_state.connection_id != connection.id || !schema_state.databases.length) {
        return;
    }

    for (const database_info of schema_state.databases) {
        const key = getNavigatorDatabaseKey(connection.id, database_info.database);
        if (expanded) {
            navigator_state.databases[key] = true;
        } else {
            delete navigator_state.databases[key];
        }
    }
    saveNavigatorState();
    renderNavigatorTree();

    if (expanded) {
        for (const database_info of schema_state.databases) {
            if (!schema_state.tables[database_info.database] && !schema_state.loading_tables[database_info.database]) {
                loadTables(connection.url, connection.user, connection.password, database_info.database);
            }
        }
    }
}

function isTableExpanded(connection_id, database_name, table_name) {
    return !!navigator_state.tables[getNavigatorTableKey(connection_id, database_name, table_name)];
}

function setTablesExpanded(connection_id, database_name, table_names, expanded) {
    for (const table_name of table_names) {
        const key = getNavigatorTableKey(connection_id, database_name, table_name);
        if (expanded) {
            navigator_state.tables[key] = true;
        } else {
            delete navigator_state.tables[key];
        }
    }
    saveNavigatorState();
}

function matchesSchemaFilter(database_name, filter) {
    if (!filter) {
        return true;
    }

    if (database_name.toLowerCase().includes(filter)) {
        return true;
    }

    const cached_tables = schema_state.tables[database_name] || [];
    return cached_tables.some(elem => `${database_name}.${elem.table}`.toLowerCase().includes(filter));
}

function formatConnectionSummary(connection) {
    const raw_url = (connection.url || '').trim();
    const without_protocol = raw_url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    const compact_url = without_protocol || raw_url || 'server';
    return connection.user && connection.user != 'default'
        ? `${connection.user}@${compact_url}`
        : compact_url;
}

function getConnectionHostParts(raw_url) {
    const raw = (raw_url || '').trim();
    if (!raw) {
        return { host: '', port: '' };
    }

    try {
        const parsed = new URL(raw);
        return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port: parsed.port };
    } catch (e) {
        const authority = raw
            .replace(/^[a-z]+:\/\//i, '')
            .split('/')[0]
            .split('@')
            .pop();
        const ipv6_match = authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
        if (ipv6_match) {
            return { host: ipv6_match[1], port: ipv6_match[2] || '' };
        }

        const host_port_match = authority.match(/^([^:]+)(?::(\d+))?$/);
        return {
            host: host_port_match ? host_port_match[1] : authority,
            port: host_port_match ? host_port_match[2] || '' : ''
        };
    }
}

function normaliseConnectionHostName(value) {
    const parts = getConnectionHostParts(value);
    return (parts.host || String(value || '').trim()).toLowerCase().replace(/\.$/, '');
}

function formatConnectionHeaderSummary(connection) {
    if (connection.user && connection.user != 'default') {
        return formatConnectionSummary(connection);
    }

    const url_parts = getConnectionHostParts(connection.url);
    const connection_name = normaliseConnectionHostName(connection.name);
    const connection_host = normaliseConnectionHostName(connection.url);
    if (connection_name && connection_host && connection_name == connection_host) {
        return url_parts.port ? `:${url_parts.port}` : '';
    }

    return formatConnectionSummary(connection);
}

function formatConnectionDisplayLabel(connection) {
    const summary = formatConnectionHeaderSummary(connection);
    if (!summary) {
        return connection.name || 'Connection';
    }

    const separator = summary.startsWith(':') ? ' ' : ' · ';
    return `${connection.name || 'Connection'}${separator}${summary}`;
}

function isMaterializedViewEngine(engine) {
    return /materialized\s+view/i.test(engine || '');
}

function isViewEngine(engine) {
    return /view/i.test(engine || '');
}

function isDictionaryEngine(engine) {
    return /^Dictionary$/i.test((engine || '').trim());
}

function isReplicatedTableEngine(engine) {
    return /^Replicated/i.test(engine || '') && !isViewEngine(engine);
}

function getSchemaItemKind(engine) {
    if (isDictionaryEngine(engine)) {
        return 'dictionary';
    }

    if (isMaterializedViewEngine(engine)) {
        return 'materialized-view';
    }

    return isViewEngine(engine) ? 'view' : 'table';
}

function getSchemaItemIcon(kind) {
    switch (kind) {
        case 'materialized-view':
            return '◳';
        case 'dictionary':
            return '▧';
        case 'view':
            return '◰';
        case 'table':
        default:
            return '▤';
    }
}

function getConnectionDashboardUrl(connection) {
    const raw_url = (connection?.url || '').trim();
    if (!raw_url) {
        return '';
    }

    const user = (connection?.user || '').trim();
    try {
        const dashboard_url = new URL('/dashboard', new URL(raw_url));
        if (user) {
            dashboard_url.searchParams.set('user', user);
        }
        return dashboard_url.toString();
    } catch (e) {
        const trimmed = raw_url.replace(/\/+$/, '').replace(/\/play$/i, '');
        if (!trimmed) {
            return '';
        }

        const dashboard_url = `${trimmed}/dashboard`;
        return user ? `${dashboard_url}?user=${encodeURIComponent(user)}` : dashboard_url;
    }
}

function copyConnectionPasswordToClipboard(connection) {
    const password = connection?.password || '';
    if (!password || !navigator.clipboard || typeof navigator.clipboard.writeText != 'function') {
        return;
    }

    try {
        navigator.clipboard.writeText(password).catch(() => {});
    } catch (e) {
        // Clipboard access can fail on non-secure origins.
    }
}

function openConnectionDashboard(connection) {
    if (!connection || !(connection.url || '').trim()) {
        return;
    }

    openDashboardForConnection(connection);
}

function openConnectionSchema(connection) {
    if (!connection || !(connection.url || '').trim()) {
        return;
    }

    openSchemaForConnection(connection);
}

function buildSelectStatement(database, table, columns) {
    if (!columns.length) {
        return `SELECT * FROM ${database}.${table} LIMIT 100;`;
    }

    const column_lines = columns.map((column, index) =>
        `    ${column.name}${index < columns.length - 1 ? ',' : ''}`);

    return `SELECT
${column_lines.join('\n')}
FROM ${database}.${table}
LIMIT 100;`;
}

function buildReadableCountStatement(database, table) {
    return `SELECT formatReadableQuantity(count(*)) AS readable_count FROM ${database}.${table};`;
}

function buildColumnStatsStatement(database, table, column) {
    return `SELECT
    quantile(0.50)(${column}) AS p50_${column},
    quantile(0.95)(${column}) AS p95_${column},
    quantile(0.99)(${column}) AS p99_${column},
    min(${column}) AS min_${column},
    avg(${column}) AS avg_${column},
    max(${column}) AS max_${column}
FROM ${database}.${table};`;
}

function getClickHouseBaseType(type) {
    let base_type = (type || '').trim();
    let previous_type = '';

    while (base_type && base_type != previous_type) {
        previous_type = base_type;
        const wrapper_match = base_type.match(/^(Nullable|LowCardinality)\((.*)\)$/i);
        if (wrapper_match) {
            base_type = wrapper_match[2].trim();
        }
    }

    return base_type;
}

function isNumericClickHouseType(type) {
    const base_type = getClickHouseBaseType(type);
    return /^(U?Int(8|16|32|64|128|256)|Float(32|64)|BFloat16)\b/i.test(base_type)
        || /^Decimal(32|64|128|256)?\s*\(/i.test(base_type);
}

function buildDropStatement(database, table, engine) {
    if (isDictionaryEngine(engine)) {
        return `DROP DICTIONARY ${database}.${table};`;
    }

    if (isViewEngine(engine)) {
        return `DROP VIEW ${database}.${table};`;
    }

    const cluster_clause = isReplicatedTableEngine(engine) ? ` ON CLUSTER '{cluster}' SYNC` : '';
    return `DROP TABLE ${database}.${table}${cluster_clause};`;
}

function buildDropDictionaryOnClusterStatement(database, table) {
    return `DROP DICTIONARY ${database}.${table} ON CLUSTER '{cluster}' SYNC;`;
}

function createNavigatorLabel(icon, text, icon_class = '') {
    const label = document.createElement('span');
    label.className = 'navigator-inline-label';

    if (icon !== '')
    {
        const icon_elem = document.createElement('span');
        icon_elem.className = `navigator-node-icon ${icon_class}`.trim();
        icon_elem.innerText = icon;
        icon_elem.setAttribute('aria-hidden', 'true');
        label.appendChild(icon_elem);
    }

    const text_elem = document.createElement('span');
    text_elem.className = 'navigator-inline-text';
    text_elem.innerText = text;


    label.appendChild(text_elem);
    return label;
}
