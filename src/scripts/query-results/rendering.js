let row_idx = 0;
let elapsed_ns = 0;
let incomplete_result = false;
let is_explain_graph = false;
let explain_graph = '';
let column_is_number = {};
let extremes = {};
let header = {};

const default_format = 'JSONStringsEachRowWithProgress';
const non_clipboard_result_formats = new Set([
    'null',
    'rawblob'
]);
const always_clipboard_text_result_formats = new Set([
    'vertical'
]);
const binary_result_format_prefixes = [
    'arrow',
    'avro',
    'bson',
    'capnproto',
    'cbor',
    'msgpack',
    'native',
    'orc',
    'parquet',
    'protobuf',
    'rowbinary'
];

function getExplicitFormatName(query) {
    const match = query.match(/\bFORMAT\s+([A-Za-z][A-Za-z0-9_]*)/i);
    return match ? match[1] : '';
}

function isClipboardTextFormat(format) {
    const normalized_format = (format || '').toLowerCase();
    if (!normalized_format || non_clipboard_result_formats.has(normalized_format)) {
        return false;
    }

    if (always_clipboard_text_result_formats.has(normalized_format)) {
        return true;
    }

    return !binary_result_format_prefixes.some(prefix => normalized_format.startsWith(prefix));
}

function canCopyRenderedResult(is_raw, is_table, format) {
    return is_raw || is_table || always_clipboard_text_result_formats.has((format || '').toLowerCase());
}

function getClickHouseSummary(response) {
    const summary = response?.headers?.get('X-ClickHouse-Summary');
    if (!summary) {
        return null;
    }

    try {
        return JSON.parse(summary);
    } catch (e) {
        return null;
    }
}

function formatClickHouseSummary(summary) {
    const read_rows = Number(summary.read_rows || 0);
    const read_bytes = Number(summary.read_bytes || 0);
    const written_rows = Number(summary.written_rows || 0);
    const written_bytes = Number(summary.written_bytes || 0);
    const parts = [];

    if (read_rows || read_bytes) {
        parts.push(`Read ${formatReadableRows(read_rows)} rows, ${formatReadableBytes(read_bytes)}`);
    }
    if (written_rows || written_bytes) {
        parts.push(`Wrote ${formatReadableRows(written_rows)} rows, ${formatReadableBytes(written_bytes)}`);
    }

    return parts.join(', ');
}

function formatResultRows(rows, incomplete = false) {
    const rowCount = Number(rows || 0);
    if (!Number.isFinite(rowCount) || rowCount < 0) {
        return '';
    }

    const unit = rowCount == 1 ? 'row' : 'rows';
    return `${formatReadableRows(rowCount)}${incomplete ? '+' : ''} ${unit} in result`;
}

function markResultIncomplete() {
    if (incomplete_result) {
        return;
    }

    incomplete_result = true;
    updateProgressText();
}

function formatElapsedMs(elapsedNs, label = '') {
    const elapsedMs = Number(elapsedNs || 0) / 1e6;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
        return '';
    }

    const roundedMs = elapsedMs < 10
        ? elapsedMs.toFixed(1)
        : Math.round(elapsedMs).toLocaleString('en-US');
    return `${label ? `${label} ` : ''}${roundedMs} ms`;
}

function formatMsMetric(value, label) {
    if (!hasMsMetricValue(value)) {
        return '';
    }

    const ms = Number(value);
    const roundedMs = ms < 10
        ? ms.toFixed(1)
        : Math.round(ms).toLocaleString('en-US');
    return `${label} ${roundedMs}ms`;
}

function formatNsAsMsMetric(value, label) {
    return formatMsMetric(Number(value || 0) / 1e6, label);
}

function hasMsMetricValue(value) {
    if (value === null || value === undefined || value === '') {
        return false;
    }

    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 0;
}

function sumMsMetrics(...values) {
    const metric_values = values.filter(hasMsMetricValue);
    if (!metric_values.length) {
        return null;
    }

    return metric_values.reduce((sum, value) => sum + Number(value), 0);
}

function setResultStats(result = current_result_meta, base_stats = result?.base_stats || '', timing_stats = result?.timing_stats || '') {
    if (!result) {
        return '';
    }

    result.base_stats = base_stats;
    result.timing_stats = timing_stats;
    result.stats = [base_stats, timing_stats].filter(Boolean).join(', ');

    if (result.elements?.result_stats) {
        result.elements.result_stats.textContent = result.stats;
        result.elements.result_stats.classList.toggle('loading', !!result.stats_loading);
        result.elements.result_stats.title = result.timing_stats
            ? 'query is total server wall time; parenthesized timings are ClickHouse profile counters and may not add up to query time.'
            : '';
    }
    if (result.id == active_result_id) {
        const stats = document.getElementById('stats');
        stats.innerText = result.stats;
        stats.title = result.elements?.result_stats?.title || '';
    }

    const history_entry = action_history.find(entry => entry.result_id == result.id);
    if (history_entry) {
        history_entry.stats = result.stats;
        renderActionHistory();
    }

    return result.stats;
}

function setResultStatsLoading(result = current_result_meta, loading = false) {
    if (!result) {
        return;
    }

    result.stats_loading = loading;
    result.elements?.result_stats?.classList.toggle('loading', loading);
}

function formatQueryLogStats(row) {
    if (!row) {
        return '';
    }

    const network_ms = sumMsMetrics(row.network_send_ms, row.network_receive_ms);
    const query = formatMsMetric(row.query_ms, 'query');
    const detail_parts = [
        formatMsMetric(row.cpu_ms, 'cpu'),
        formatMsMetric(network_ms, 'network'),
        formatMsMetric(row.io_wait_ms, 'io wait')
    ].filter(Boolean);
    const parts = [];

    if (query) {
        parts.push(detail_parts.length ? `${query} (${detail_parts.join(', ')})` : query);
    } else {
        parts.push(...detail_parts);
    }

    if (Number(row.memory_usage || 0) > 0) {
        parts.push(`memory ${formatReadableBytes(row.memory_usage)}`);
    }

    return parts.join(', ');
}

function applyClickHouseSummary(response) {
    const summary = getClickHouseSummary(response);
    if (!summary) {
        return false;
    }

    if (summary.elapsed_ns) {
        elapsed_ns = Number(summary.elapsed_ns);
    }

    const text = formatClickHouseSummary(summary);
    if (!text) {
        return false;
    }

    const result = getRenderResultMeta();
    if (result) {
        result.summary_stats = text;
    }
    return text;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getQueryLogPollDelay(elapsed_ms) {
    if (!elapsed_ms) {
        return 500;
    }

    return elapsed_ms < query_log_poll_fast_window_ms ? 1000 : 5000;
}

async function fetchQueryLogStats(server_address, user, password, query_id) {
    const url = buildClickHouseUrl(server_address, user, password, 'JSONEachRow', {
        param_query_id: query_id
    });

    const response = await fetch(url, {
        method: 'POST',
        body: `SELECT
    query_duration_ms AS query_ms,
    if(
        mapContains(ProfileEvents, 'UserTimeMicroseconds')
            OR mapContains(ProfileEvents, 'OSUserTimeMicroseconds')
            OR mapContains(ProfileEvents, 'OSCPUVirtualTimeMicroseconds'),
        round(greatest(
            ProfileEvents['UserTimeMicroseconds'] + ProfileEvents['SystemTimeMicroseconds'],
            ProfileEvents['OSUserTimeMicroseconds'] + ProfileEvents['OSSystemTimeMicroseconds'],
            ProfileEvents['OSCPUVirtualTimeMicroseconds']
        ) / 1000, 1),
        NULL
    ) AS cpu_ms,
    if(
        mapContains(ProfileEvents, 'NetworkSendElapsedMicroseconds'),
        round(ProfileEvents['NetworkSendElapsedMicroseconds'] / 1000, 1),
        NULL
    ) AS network_send_ms,
    if(
        mapContains(ProfileEvents, 'NetworkReceiveElapsedMicroseconds'),
        round(ProfileEvents['NetworkReceiveElapsedMicroseconds'] / 1000, 1),
        NULL
    ) AS network_receive_ms,
    if(
        mapContains(ProfileEvents, 'OSIOWaitMicroseconds'),
        round(ProfileEvents['OSIOWaitMicroseconds'] / 1000, 1),
        NULL
    ) AS io_wait_ms,
    memory_usage
FROM system.query_log
WHERE (
    type = 'QueryFinish'
    OR (
        type = 'ExceptionWhileProcessing'
        AND (
            exception ILIKE '%Broken pipe%'
            OR exception ILIKE '%socket%'
            OR exception ILIKE '%NETWORK_ERROR%'
        )
    )
)
  AND (query_id = {query_id:String} OR initial_query_id = {query_id:String})
ORDER BY event_time_microseconds DESC
LIMIT 1`,
    });

    if (!response.ok) {
        return null;
    }

    const text = (await response.text()).trim();
    if (!text) {
        return null;
    }

    return JSON.parse(text.split('\n')[0]);
}

async function enrichResultStatsFromQueryLog(result, server_address, user, password, query_id) {
    if (!query_id) {
        return;
    }

    setResultStatsLoading(result, true);
    const started_at = performance.now();
    let elapsed_ms = 0;

    while (elapsed_ms < query_log_poll_timeout_ms) {
        const delay = Math.min(
            getQueryLogPollDelay(elapsed_ms),
            query_log_poll_timeout_ms - elapsed_ms
        );
        await sleep(delay);
        if (!result_history.includes(result) || result.query_id != query_id) {
            return;
        }
        elapsed_ms = performance.now() - started_at;

        try {
            const row = await fetchQueryLogStats(server_address, user, password, query_id);
            const query_log_stats = formatQueryLogStats(row);
            if (query_log_stats) {
                result.query_log_stats = query_log_stats;
                setResultStatsLoading(result, false);
                setResultStats(result, result.base_stats, query_log_stats);
                return;
            }
        } catch (e) {
            console.log(e);
            setResultStatsLoading(result, false);
            return;
        }
    }

    setResultStatsLoading(result, false);
}

let controller = null;
async function postImpl(posted_request_num, query, result = current_result_meta)
{
    const previous_render_result_elements = render_result_elements;
    const previous_render_result_meta = render_result_meta;

    render_result_elements = result?.elements || null;
    render_result_meta = result || null;

    try {
        return await postImplForRenderTarget(posted_request_num, query);
    } finally {
        render_result_elements = previous_render_result_elements;
        render_result_meta = previous_render_result_meta;
    }
}

async function postImplForRenderTarget(posted_request_num, query)
{
    const result = getRenderResultMeta();
    const elements = getRenderResultElements();
    const user = user_elem.value;
    const password = password_elem.value;
    const server_address = url_elem.value;
    const explicit_format = getExplicitFormatName(query);
    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?') +
        /// Ask server to allow cross-domain requests.
        'add_http_cors_header=1';
    if (user) url += '&user=' + encodeURIComponent(user);
    if (password) url += '&password=' + encodeURIComponent(password);
    url += '&default_format=' + default_format + '&enable_http_compression=1';
    /// Optional: write the interactive result into query cache so a later download can reuse it.
    if (shouldUseQueryCacheForDownload()) {
        url += '&use_query_cache=1&enable_reads_from_query_cache=0&enable_writes_to_query_cache=1&query_cache_ttl=600&query_cache_nondeterministic_function_handling=save';
    }

    /// Extremes only if the format is likely to be unchanged. This is imprecise.
    if (!explicit_format) url += '&extremes=1';

    last_query_start = performance.now();

    setResultTabSucceeded(result, false);
    setResultDownloadButtonVisible(elements, false);
    document.getElementById('hourglass').style.display = 'inline-block';

    clear();

    let is_table = false;
    let is_raw = false;
    let is_chart = false;
    let is_error = false;

    let response, reply, format, query_id;
    reply = '';
    try {
        controller = new AbortController();
        response = await fetch(url, { method: "POST", body: query, signal: controller.signal,
            headers: { 'Authorization': 'never' } });

        format = response.headers.get('X-ClickHouse-Format') ?? default_format;
        query_id = response.headers.get('X-ClickHouse-Query-Id') || '';
        if (result) {
            result.query_id = query_id;
        }

        if (!response.ok) {
            is_error = true;
            reply = await response.text();
            if (posted_request_num != request_num) { return; }

            let has_exception = false;
            for (line of reply.split('\n')) {
                if (line.startsWith(`{"exception":`)) {
                    update(JSON.parse(line));
                    has_exception = true;
                    break;
                }
            }
            if (!has_exception) {
                renderError(reply);
            }

            if (result) {
                result.ok = false;
                setResultTabFailed(result);
                result.stats = result.elements.result_stats.innerText || (isRenderResultActive() ? document.getElementById('stats').innerText : '') || '';
                result.elements.result_stats.innerText = result.stats;
                action_history.push({
                    result_id: result.id,
                    request_num: result.request_num,
                    connection_name: result.connection_name,
                    query: query,
                    message: reply || 'Query failed',
                    stats: result.stats,
                    ok: false
                });
                renderActionHistory();
            }

            document.getElementById('hourglass').style.display = 'none';
            setResultDownloadButtonVisible(elements, false);
            document.documentElement.style.setProperty('--progress', '0');
            return;
        } else if (format == default_format) {
            is_table = true;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            let buffer = '';
            let stream_aborted = false;
            let draining_after_preview_limit = false;
            const updateDefaultFormatLine = (line, fragment, append_raw_newline, render_rows = true) => {
                if (!line.trim()) {
                    return true;
                }

                if (!render_rows && line.startsWith('{"row":')) {
                    markResultIncomplete();
                    return true;
                }

                let data;
                try {
                    data = JSON.parse(line);
                } catch (e) {
                    if (!render_rows) {
                        return true;
                    }
                    is_table = false;
                    is_raw = true;
                    updateRaw(append_raw_newline ? `${line}\n` : line);
                    return true;
                }

                if (!render_rows && data.row) {
                    markResultIncomplete();
                    return true;
                }

                return update(data, fragment) !== false;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (posted_request_num != request_num) { return; }
                if (done) {
                    const trailing_content = decoder.decode();
                    if (trailing_content) {
                        buffer += trailing_content;
                        if (!draining_after_preview_limit) {
                            reply += trailing_content;
                        }
                    }
                    break;
                }

                let new_content = decoder.decode(value, { stream: true });
                buffer += new_content;
                if (!draining_after_preview_limit) {
                    reply += new_content;
                }

                let lines = buffer.split('\n');
                let fragment = document.createDocumentFragment();

                let cont = true;
                for (const line of lines.slice(0, -1)) {
                    cont = updateDefaultFormatLine(line, fragment, true, !draining_after_preview_limit);
                    if (!cont) { break; }
                }

                if (fragment.hasChildNodes()) {
                    getCurrentTbody()?.appendChild(fragment);
                }

                if (!cont)
                {
                    if (shouldAbortAtPreviewLimit()) {
                        stream_aborted = true;
                        controller.abort();
                        break;
                    }

                    draining_after_preview_limit = true;
                    buffer = '';
                    continue;
                }
                buffer = lines[lines.length - 1];
            }

            if (!stream_aborted && buffer.trim()) {
                let fragment = document.createDocumentFragment();
                const cont = updateDefaultFormatLine(buffer, fragment, false, !draining_after_preview_limit);
                if (fragment.hasChildNodes()) {
                    getCurrentTbody()?.appendChild(fragment);
                }
                if (!cont) {
                    if (shouldAbortAtPreviewLimit()) {
                        controller.abort();
                    }
                }
            }
        } else if (format == 'JSONCompactColumns') {
            is_chart = true;
            reply = await response.text();
            if (posted_request_num != request_num) { return; }
            renderChart(JSON.parse(reply));
        } else {
            is_raw = true;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                let new_content = decoder.decode(value, { stream: true });
                reply += new_content;

                if (posted_request_num != request_num) { return; }
                updateRaw(new_content);
            }
        }
    } catch (e) {
        if (posted_request_num != request_num) { return; }

        console.log(e);
        if (e instanceof TypeError) {
            reply = "Network error";
        } else if (e.name === 'AbortError') {
            reply = "Query was cancelled";
        } else {
            reply = e.toString();
        }
        renderError(reply);
        if (result) {
            result.ok = false;
            setResultTabFailed(result);
            result.stats = '';
            result.elements.result_stats.innerText = '';
            action_history.push({
                result_id: result.id,
                request_num: result.request_num,
                connection_name: result.connection_name,
                query: query,
                message: reply || 'Query failed',
                stats: '',
                ok: false
            });
            renderActionHistory();
        }
        document.getElementById('hourglass').style.display = 'none';
        setResultDownloadButtonVisible(elements, false);
        setResultTabFailed(result);
        document.documentElement.style.setProperty('--progress', '0');
        return;
    }

    if (is_explain_graph) {
        await renderGraph();
    } else {
        if (extremes['min'] && extremes['max']) renderExtremes();
        if (is_table) transposeTableIfNeeded();
    }

    document.getElementById('hourglass').style.display = 'none';
    const has_table_result = is_table && Object.keys(header).length > 0;
    const has_result_payload = has_table_result || is_raw || is_chart || is_explain_graph;
    setResultDownloadButtonVisible(elements, has_result_payload);
    if (isRenderResultActive()) {
        last_query_for_download = query;
    }
    if (result) {
        result.format = format;
        result.is_table = has_table_result;
        result.is_raw = is_raw;
        result.is_chart = is_chart;
        result.is_error = is_error;
    }

    const copy_format = explicit_format || format;
    if (has_table_result) {
        showResultCopyButton(elements, 'result');
    } else if (explicit_format && isClipboardTextFormat(copy_format) && canCopyRenderedResult(is_raw, is_table, copy_format)) {
        elements.copy_text = reply;
        showResultCopyButton(elements, copy_format);
    } else {
        resetResultCopyButton(elements);
    }

    if (is_raw || !elapsed_ns) {
        elapsed_ns = 1e6 * (performance.now() - last_query_start);
    }

    const summary_text = applyClickHouseSummary(response) || '';
    const progress_text = row_idx || has_table_result ? formatResultRows(row_idx, incomplete_result) : '';
    const base_stats_text = [progress_text, summary_text].filter(Boolean).join(', ');
    const timing_stats_text = formatNsAsMsMetric(elapsed_ns, 'query');
    const result_stats_text = setResultStats(result, base_stats_text, timing_stats_text);
    document.documentElement.style.setProperty('--progress', '0');

    if (result) {
        result.ok = true;
        setResultTabSucceeded(result, true);
        if (!result.stats) {
            result.stats = result_stats_text || result.elements.result_stats.innerText || (isRenderResultActive() ? document.getElementById('stats').innerText || document.getElementById('progress').innerText : '') || '';
            result.elements.result_stats.innerText = result.stats;
        }
        clearElement(document.getElementById('progress'));
        action_history.push({
            result_id: result.id,
            request_num: result.request_num,
            connection_name: result.connection_name,
            query: query,
            message: row_idx ? `${row_idx}${incomplete_result ? '+' : ''} row(s) rendered` : (is_raw ? 'Raw result' : 'Completed'),
            stats: result.stats,
            ok: true
        });
        renderActionHistory();
        if (query_id && (has_result_payload || summary_text)) {
            void enrichResultStatsFromQueryLog(result, server_address, user, password, query_id);
        }
    }

    if (posted_request_num != request_num) { return; }

    /// The query is saved in browser history (in a state JSON object)
    /// as well as in URL fragment identifier.
    if (query != previous_query) {
        const state = {
            query: query,
            format: format,
            ok: response.ok,
            data: reply.length > 100000 ? null : reply, /// Lower than the browser's limit.
            elapsed_ns: elapsed_ns,
        };
        const title = "ClickHouse Query: " + query;

        let history_url = window.location.pathname + '?view=query&user=' + encodeURIComponent(user);
        if (run_immediately) {
            history_url += "&run=1";
        }
        if (server_address != location.origin) {
            /// Save server's address in URL if it's not identical to the address of the play UI.
            history_url += '&url=' + encodeURIComponent(server_address);
        }
        history_url += '#' + toBase64(query);

        if (previous_query == '') {
            history.replaceState(state, title, history_url);
        } else {
            history.pushState(state, title, history_url);
        }
        document.title = title;
        previous_query = query;
    }
}

async function restoreFromHistory(state) {
    resetResultPanels();
    createResultPanel(++request_num, state.query);
    clear();
    query_area.value = state.query;
    void updateQueryHighlighting();

    if (!state.data) return;

    let is_table = false;
    let is_raw = false;
    let is_chart = false;
    let is_error = false;

    let format = state.format;
    const explicit_format = getExplicitFormatName(state.query);

    if (!state.ok) {
        is_error = true;

        let has_exception = false;
        for (line of state.data.split('\n')) {
            if (line.startsWith(`{"exception":`)) {
                update(JSON.parse(line));
                has_exception = true;
                break;
            }
        }
        if (!has_exception) {
            renderError(state.data);
        }

        document.getElementById('hourglass').style.display = 'none';
        setResultDownloadButtonVisible(current_result_elements, false);
        if (current_result_meta) {
            current_result_meta.ok = false;
            setResultTabFailed(current_result_meta);
        }
        document.documentElement.style.setProperty('--progress', '0');
        return;
    } else if (format == default_format) {
        is_table = true;
        let lines = state.data.split('\n');
        let fragment = document.createDocumentFragment();

        for (const line of lines) {
            if (line.length == 0) continue;
            if (update(JSON.parse(line), fragment) === false) { break; }
        }

        if (fragment.hasChildNodes()) {
            getCurrentTbody()?.appendChild(fragment);
        }
    } else if (format == 'JSONCompactColumns') {
        is_chart = true;
        renderChart(JSON.parse(state.data));
    } else {
        is_raw = true;
        updateRaw(state.data);
    }

    if (is_explain_graph) {
        await renderGraph();
    } else {
        if (extremes['min'] && extremes['max']) renderExtremes();
        if (is_table) transposeTableIfNeeded();
    }

    document.getElementById('hourglass').style.display = 'none';
    const has_table_result = is_table && Object.keys(header).length > 0;
    const has_result_payload = has_table_result || is_raw || is_chart || is_explain_graph;
    setResultDownloadButtonVisible(current_result_elements, has_result_payload);
    last_query_for_download = state.query;
    if (current_result_meta) {
        current_result_meta.format = format;
        current_result_meta.is_table = has_table_result;
        current_result_meta.is_raw = is_raw;
        current_result_meta.is_chart = is_chart;
        current_result_meta.is_error = is_error;
        current_result_meta.ok = true;
        setResultTabSucceeded(current_result_meta, true);
    }

    const copy_format = explicit_format || format;
    if (has_table_result) {
        showResultCopyButton(current_result_elements, 'result');
    } else if (explicit_format && isClipboardTextFormat(copy_format) && canCopyRenderedResult(is_raw, is_table, copy_format)) {
        current_result_elements.copy_text = state.data;
        showResultCopyButton(current_result_elements, copy_format);
    } else {
        resetResultCopyButton();
    }

    elapsed_ns = state.elapsed_ns || elapsed_ns;

    const restored_base_stats_text = row_idx || has_table_result ? formatResultRows(row_idx, incomplete_result) : '';
    const restored_timing_stats_text = formatNsAsMsMetric(elapsed_ns, 'query');
    if (current_result_meta) {
        setResultStats(current_result_meta, restored_base_stats_text, restored_timing_stats_text);
    }
    document.documentElement.style.setProperty('--progress', '0');
}

appendTextareaResizer();

window.onpopstate = function(event) {
    if (!event.state) return;
    restoreFromHistory(event.state);
};

if (window.location.hash) {
    query_area.value = fromBase64(window.location.hash.substr(1));
}

let armed_run_selection = null;

function getQuerySelectionSnapshot() {
    const value_length = query_area.value.length;
    const raw_start = query_area.selectionStart ?? value_length;
    const raw_end = query_area.selectionEnd ?? raw_start;
    const start = Math.max(0, Math.min(raw_start, raw_end, value_length));
    const end = Math.max(0, Math.min(Math.max(raw_start, raw_end), value_length));

    if (start == end) {
        return null;
    }

    return {
        start,
        end,
        text: query_area.value.substring(start, end),
    };
}

function selectionSnapshotStillMatches(selection) {
    return !!selection
        && selection.start >= 0
        && selection.end <= query_area.value.length
        && selection.start < selection.end
        && query_area.value.substring(selection.start, selection.end) == selection.text;
}

function getFocusedQuerySelection() {
    return document.activeElement == query_area ? getQuerySelectionSnapshot() : null;
}

function refreshRunSelectionState() {
    armed_run_selection = null;
    updateRunButtonText();
}

function clearRunSelectionState() {
    armed_run_selection = null;
    updateRunButtonText();
}

function getRunScript(use_armed_selection = false) {
    if (use_armed_selection && selectionSnapshotStillMatches(armed_run_selection)) {
        return armed_run_selection.text;
    }

    armed_run_selection = null;
    return getFocusedQuerySelection()?.text ?? query_area.value;
}

function updateRunButtonText() {
    const has_selection = !!getFocusedQuerySelection();
    const text = in_flight ? 'Stop' : (has_selection ? 'Run selected' : 'Run all');
    const label = in_flight ? 'Stop running query' : `${text} (Ctrl/Cmd+Enter)`;
    run_button.innerText = text;
    run_button.title = label;
    run_button.setAttribute('aria-label', label);
}

function setEditorCompact(compact, save = true) {
    const query_div = document.getElementById('query_div');

    if (compact && !query_div.classList.contains('compact')) {
        query_editor_expanded_height = query_area.style.height;
    }

    query_div.classList.toggle('compact', compact);
    toggle_editor_elem.setAttribute('aria-pressed', compact ? 'true' : 'false');
    toggle_editor_elem.title = compact ? 'Expand query editor' : 'Compact query editor';
    toggle_editor_elem.setAttribute('aria-label', toggle_editor_elem.title);
    toggle_editor_elem.textContent = compact ? '▾' : '▴';

    if (!compact && query_editor_expanded_height) {
        query_area.style.height = query_editor_expanded_height;
    }
    syncQueryBackdropLayout();
    positionAutocompleteMenu();

    if (save) {
        window.localStorage.setItem(query_editor_compact_key, compact ? '1' : '0');
    }
}

let in_flight = false;
async function post(use_armed_selection = false)
{
    stop_after_current = false;
    controller = null;
    in_flight = true;
    updateRunButtonText();

    try {
        const script = getRunScript(use_armed_selection);
        const queries = await getQueriesToRun(script);
        if (!queries.length) {
            return;
        }

        resetResultPanels();
        scrollResultsToTop();

        for (const query of queries) {
            if (stop_after_current) {
                break;
            }

            ++request_num;
            const result = createResultPanel(request_num, query);
            await postImpl(request_num, query, result);
        }
    } finally {
        armed_run_selection = null;
        run_button.blur();
        in_flight = false;
        updateRunButtonText();
    }
}

async function cancel()
{
    stop_after_current = true;
    if (controller) controller.abort();
    in_flight = false;
    updateRunButtonText();
}

document.getElementById('controls').addEventListener('submit', e =>
{
    e.preventDefault();
    if (in_flight) {
        cancel();
    } else {
        post(e.submitter == run_button);

        if (password_elem.value) {
            const cred = new PasswordCredential({
                id: user_elem.value,
                password: password_elem.value,
                name: url_elem.value,
            });
            navigator.credentials.store(cred);
        }
    }
});

document.addEventListener('keydown', event => {
    /// Firefox has code 13 for Enter and Chromium has code 10.
    if ((event.metaKey || event.ctrlKey) && (event.keyCode == 13 || event.keyCode == 10)) {
        if (current_workspace_view != 'query') {
            return;
        }
        document.getElementById('controls').requestSubmit();
    }
});

run_button.addEventListener('pointerdown', event => {
    const selection = getFocusedQuerySelection();
    if (in_flight || (event.button !== undefined && event.button != 0) || !selection) {
        return;
    }

    armed_run_selection = selection;
    event.preventDefault();
});

['click', 'select', 'keyup', 'change', 'mouseup'].forEach(event_name =>
    query_area.addEventListener(event_name, refreshRunSelectionState)
);

['focus', 'blur', 'input'].forEach(event_name =>
    query_area.addEventListener(event_name, clearRunSelectionState)
);

['focus', 'click', 'keyup', 'mouseup', 'select', 'input'].forEach(event_name =>
    query_area.addEventListener(event_name, rememberQueryEditorSelection)
);

toggle_editor_elem.addEventListener('click', () => {
    setEditorCompact(!document.getElementById('query_div').classList.contains('compact'));
});

query_area.addEventListener('keydown', handleQueryAutocompleteKeyDown, true);
query_area.addEventListener('keydown', handleQueryEditorKeyDown);
query_area.addEventListener('blur', clearQueryEditorTabExitArm);

function clearElement(elem)
{
    if (!elem) {
        return;
    }
    while (elem.firstChild) {
        elem.removeChild(elem.lastChild);
    }
    elem.style.display = 'none';
}

function clear()
{
    const result = getRenderResultMeta();
    const elements = getRenderResultElements();

    clearElement(elements?.data_table);
    clearElement(elements?.graph);
    clearElement(elements?.chart);
    clearElement(elements?.data_unparsed);
    clearElement(elements?.error);
    if (isRenderResultActive()) {
        clearElement(document.getElementById('progress'));
        document.getElementById('stats').innerText = '';
    }
    setResultDownloadButtonVisible(elements, false);
    resetResultCopyButton(elements);

    elements?.data_table?.classList.remove('fixed');
    elements?.data_div?.classList.remove('fixed');
    if (elements?.data_div) {
        elements.data_div.style.display = 'none';
    }
    setResultTabSucceeded(result, false);
    document.getElementById('hourglass').style.display = 'none';
    if (elements?.result_stats) {
        elements.result_stats.innerText = '';
        elements.result_stats.classList.remove('loading');
    }
    if (result) {
        result.stats_loading = false;
        result.progress_stats = '';
        result.progress_stats_updated_at = 0;
    }

    extremes = {};
    header = {};
    row_idx = 0;
    elapsed_ns = 0;
    incomplete_result = false;
    is_explain_graph = false;
    explain_graph = '';
}

function formatReadable(number = 0, decimals = 2, units = []) {
    const k = 1000;
    const i = number ? Math.floor(Math.log(number) / Math.log(k)) : 0;
    const unit = units[i];
    const dm = unit ? decimals : 0;
    return Number(number / Math.pow(k, i)).toFixed(dm) + unit;
}

function formatReadableBytes(bytes) {
    const units = [' B', ' KB', ' MB', ' GB', ' TB', ' PB', ' EB', ' ZB', ' YB'];

    return formatReadable(bytes, 2, units);
}

function formatReadableRows(rows) {
    const units = ['', ' thousand', ' million', ' billion', ' trillion', ' quadrillion'];

    return formatReadable(rows, 2, units);
}

function clearSelectedResultCell() {
    current_selected_cell?.classList.remove('td-selected');
    current_selected_cell?.parentElement?.classList.remove('tr-selected');
    current_selected_cell = null;
}

function selectResultCell(cell) {
    if (!cell) {
        return;
    }

    clearSelectedResultCell();
    current_selected_cell = cell;
    current_selected_cell.classList.add('td-selected');
    current_selected_cell.parentElement?.classList.add('tr-selected');
    current_selected_cell.scrollIntoView({ block: 'nearest' });
}

function getResultCellCopyValue(cell) {
    return cell?.dataset?.copyValue ?? cell?.innerText ?? '';
}

async function copyResultCellValue(cell = current_selected_cell) {
    const value = getResultCellCopyValue(cell);
    const copied = await copyTextToClipboard(value);
    if (!copied) {
        alert('Copy failed.');
    }
}

function openResultCellMenu(cell, anchor_rect) {
    showNavigatorContextMenu([
        {
            icon: '⧉',
            label: 'Copy value',
            onClick: () => copyResultCellValue(cell)
        }
    ], anchor_rect.left, anchor_rect.bottom + 4);
}

function renderCell(name, value)
{
    let td = document.createElement('td');

    let is_null = (value === null);
    let is_link = false;

    /// Test: SELECT number, toString(number) AS str, number % 2 ? number : NULL AS nullable, range(number) AS arr, CAST((['hello', 'world'], [number, number % 2]) AS Map(String, UInt64)) AS map FROM numbers(10)
    let text;
    if (is_null) {
        text = 'ᴺᵁᴸᴸ';
    } else if (typeof(value) === 'object') {
        text = JSON.stringify(value);
    } else {
        text = String(value);

        /// If it looks like URL, create a link. This is for convenience.
        if (typeof(value) == 'string' && text.match(/^https?:\/\/\S+$/)) {
            is_link = true;
        }
    }

    td.dataset.copyValue = is_null ? 'NULL' : text;
    td.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        selectResultCell(td);
        openResultCellMenu(td, { left: e.clientX, bottom: e.clientY });
    });

    let node = document.createTextNode(text);
    if (is_link) {
        let link = document.createElement('a');
        link.appendChild(node);
        link.href = text;
        link.setAttribute('target', '_blank');
        node = link;
    }

    td.className = column_is_number[name] ? 'right' : 'left';

    if (column_is_number[name]) {
        if (text.length >= 5 && text.match(/^[\d]{5,}$/)) {
            let i = 0;
            td.innerHTML = text.split('').reverse().map(c => {
                if (i > 0 && i % 3 == 0) { c = `<u>${c}<\/u>`; }; ++i; return c;
            }).reverse().join('');
            return td;
        }
    }

    td.appendChild(node);
    return td;
}

document.getElementById('query').addEventListener('focus', e => {
    clearSelectedResultCell();
});

document.addEventListener('keydown', e => {
    let cell = current_selected_cell;
    if (!cell) { return; }

    const active_element = document.activeElement;
    if (active_element && ['INPUT', 'TEXTAREA'].includes(active_element.tagName)) {
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() == 'c' && !e.shiftKey && !e.altKey) {
        if (window.getSelection()?.toString()) {
            return;
        }

        e.preventDefault();
        copyResultCellValue(cell);
        return;
    }

    const row = cell.parentElement;
    const table = row.parentElement;
    let cell_index = cell.cellIndex;
    let row_index = row.rowIndex;

    switch(e.key) {
        case 'ArrowUp': --row_index; break;
        case 'ArrowDown': ++row_index; break;
        case 'ArrowLeft': --cell_index; break;
        case 'ArrowRight': ++cell_index; break;
        default:
            return;
    }

    /// The first cell in each row is the row number.
    if (row_index < 0 || cell_index <= 0) { return; }

    let new_cell = table.rows[row_index]?.cells[cell_index];
    if (!new_cell) { return; }

    e.preventDefault();

    selectResultCell(new_cell);
});

function transposeTableIfNeeded()
{
    let table = getCurrentDataTable();
    if (Object.keys(header).length == 0 || table.rows.length > 1 || table.rows[0]?.cells.length <= 5) return;

    let heads = table.tHead.childNodes;
    let values = table.rows[0]?.cells;
    let num_cols = heads.length - 1;

    let new_tbody = document.createElement('tbody');
    for (let i = 0; i < num_cols; ++i) {
        let tr = document.createElement('tr');
        let th = heads[1];
        th.className = 'right';
        th.style.width = '0';
        th.removeChild(th.querySelector('.resizer'))
        tr.appendChild(th);
        if (values) {
            let td = values[1];
            td.classList.remove('right');
            tr.appendChild(td);
        } else if (i == 0) {
            /// If the result is empty, show this fact with a style.
            let td = document.createElement('td');
            td.rowSpan = num_cols;
            td.className = 'empty-result';
            let div = document.createElement('div');
            div.appendChild(document.createTextNode("empty result"));
            div.className = 'empty-result';
            td.appendChild(div);
            tr.appendChild(td);
        }
        new_tbody.appendChild(tr);
    }

    table.removeChild(table.tHead);
    table.removeChild(table.tBodies[0]);
    table.appendChild(new_tbody);
}

function update(json, fragment) {
    if (json.progress) {
        updateProgress(json.progress);
        return true;
    } else if (json.meta) {
        appendHeader(json.meta);
        return true;
    } else if (json.row) {
        if (is_explain_graph
            || (row_idx == 0 && Object.keys(json.row).length == 1 && json.row.explain == 'digraph'
                && query_area.value.match(/^\s*EXPLAIN/i))) {
            is_explain_graph = true;
            explain_graph += json.row.explain + '\n';
            return true;
        } else {
            return appendRow(json.row, fragment);
        }
    } else if (json.min) {
        extremes['min'] = json.min;
        return true;
    } else if (json.max) {
        extremes['max'] = json.max;
        return true;
    } else if (json.exception) {
        renderError(json.exception);
        return true;
    }

    return true;
}

function updateRaw(data) {
    const fragment = document.createTextNode(data);
    let container = getCurrentDataUnparsed();
    getCurrentDataDiv().style.display = 'block';
    container.appendChild(fragment);
    container.style.display = 'block';
}

function updateProgressText(show_progress_status = true, show_elapsed = true, elapsed_label = 'Elapsed') {
    const result = getRenderResultMeta();
    const elements = getRenderResultElements();
    let progress_elem = document.getElementById('progress');
    const server_progress_age_ms = result?.progress_stats_updated_at
        ? performance.now() - result.progress_stats_updated_at
        : Infinity;
    const server_progress_text = server_progress_age_ms < 1000
        ? result?.progress_stats || ''
        : '';
    const parts = [];
    if (row_idx) {
        parts.push(formatResultRows(row_idx, incomplete_result));
    }
    if (show_elapsed) {
        parts.push(formatElapsedMs(elapsed_ns, elapsed_label));
    }

    const rendered_progress_text = parts.filter(Boolean).join(', ');
    const progress_text = server_progress_text || (!show_progress_status ? rendered_progress_text : '');
    if (isRenderResultActive()) {
        if (server_progress_text) {
            progress_elem.innerHTML = server_progress_text;
        } else {
            progress_elem.innerText = progress_text;
        }
        progress_elem.style.display = show_progress_status && progress_text ? 'block' : 'none';
    }
    if (elements?.result_stats && !result?.stats) {
        if (server_progress_text) {
            elements.result_stats.innerHTML = server_progress_text;
        } else {
            elements.result_stats.innerText = progress_text;
        }
    }
    return progress_text;
}

function updateProgress(progress) {
    const result = getRenderResultMeta();
    const elements = getRenderResultElements();
    let stats = document.getElementById('stats');

    const rows = +progress.read_rows;
    const bytes = +progress.read_bytes;
    const total_rows = +progress.total_rows_to_read;
    elapsed_ns = +progress.elapsed_ns;

    let formatted_rows = formatReadableRows(rows);
    let formatted_bytes = formatReadableBytes(bytes);

    const rps = rows * 1e9 / elapsed_ns;
    const bps = bytes * 1e9 / elapsed_ns;

    let formatted_rps = formatReadableRows(rps) + '/sec';
    let formatted_bps = formatReadableBytes(bps) + '/sec';

    if (rows >= 1e11) { formatted_rows = `<b>${formatted_rows}<\/b>`; }
    if (bytes >= 1e12) { formatted_bytes = `<b>${formatted_bytes}<\/b>`; }
    if (rps >= 1e10) { formatted_rps = `<b>${formatted_rps}<\/b>`; }
    if (bps >= 1e10) { formatted_bps = `<b>${formatted_bps}<\/b>`; }

    let text = '';

    if (total_rows) { text += (100 * Math.min(1.0, rows / total_rows)).toFixed(1) + '%, '; }

    text += `Read ${formatted_rows} rows, ${formatted_bytes}`;

    if (rps > 1e6) { text += ` (${formatted_rps}, ${formatted_bps})`; }

    if (isRenderResultActive()) {
        stats.innerHTML = text;
    }
    if (elements?.result_stats) {
        elements.result_stats.innerHTML = text;
    }
    if (result) {
        result.progress_stats = text;
        result.progress_stats_updated_at = performance.now();
    }

    updateProgressText();

    document.documentElement.style.setProperty('--progress',
        rows && total_rows ? (100 * rows / total_rows) + '%' : '0');
}

function changeTableLayout() {
    const table = getCurrentDataTable();
    const headers = table.querySelectorAll('th');

    table.style.setProperty('--table-width', `${table.offsetWidth}px`);

    columnWidths = [];
    headers.forEach(header => {
        columnWidths.push(header.offsetWidth);
    });

    table.classList.add('fixed');
    getCurrentDataDiv().classList.add('fixed');

    headers.forEach((header, index) => {
        header.style.width = `${columnWidths[index]}px`;
    });
}


function appendHeaderResizer(header) {
    let drag_state = {
        elem: null,
        is_dragging: true,
        offset_x: null,
        offset_width: null
    };

    const start = (e) => {
        if (e.button !== 0) { return; }

        changeTableLayout();
        drag_state.offset_x = e.clientX;
        drag_state.offset_width = header.offsetWidth;
        drag_state.is_dragging = true;
        drag_state.elem = e.target;
        drag_state.elem.classList.add('resizer-dragging');

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);
    }

    const move = (e) => {
        if (!drag_state.is_dragging) { return; }

        const dx = e.clientX - drag_state.offset_x;
        header.style.width = `${drag_state.offset_width + dx}px`;
        if(dx < 0) {
            const table = getCurrentDataTable();
            table.style.setProperty('--table-width', `${table.offsetWidth + dx}px`)
        };
    }

    const stop = (e) => {
        drag_state.is_dragging = false;
        drag_state.elem.classList.remove('resizer-dragging');

        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
    }

    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    resizer.addEventListener('pointerdown', start);
    resizer.addEventListener('touchstart', (e) => e.preventDefault());

    header.appendChild(resizer);
}


function appendTextareaResizer() {
    const queryDiv = document.getElementById('query_div');
    const textarea = document.getElementById('query');

    let drag_state = {
        elem: null,
        is_dragging: false,
        offset_y: null,
        offset_height: null
    };

    const start = (e) => {
        if (e.button !== 0) { return; }

        setEditorCompact(false);
        drag_state.offset_y = e.clientY;
        drag_state.offset_height = textarea.offsetHeight;
        drag_state.is_dragging = true;
        drag_state.elem = e.target;
        drag_state.elem.classList.add('textarea-resizer-dragging');

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);
    }

    const move = (e) => {
        if (!drag_state.is_dragging) { return; }

        const dy = e.clientY - drag_state.offset_y;
        const newHeight = drag_state.offset_height + dy;

        textarea.style.height = `${newHeight}px`;
        syncQueryBackdropLayout();
        positionAutocompleteMenu();
    }

    const stop = (e) => {
        drag_state.is_dragging = false;
        drag_state.elem.classList.remove('textarea-resizer-dragging');

        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
    }

    const resizer = document.createElement('div');
    resizer.className = 'textarea-resizer';
    resizer.addEventListener('pointerdown', start);
    resizer.addEventListener('touchstart', (e) => e.preventDefault());

    queryDiv.appendChild(resizer);
}

function appendHeader(meta) {
    if (meta.length == 0) { return; }
    header = meta;

    let thead = document.createElement('thead');

    let th = document.createElement('th');
    th.className = 'row-number';
    th.appendChild(document.createTextNode('№'));
    thead.appendChild(th);

    /// Assign z-index in the reverse order.
    /// This is needed to make sure the contents that overflow to the right (column resizer) is visible.
    let zIndex = meta.length;

    meta.forEach(elem => {
        let th = document.createElement('th');
        const name = document.createTextNode(elem.name);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.appendChild(name);
        th.appendChild(nameSpan);
        let type_hint = document.createElement('span');
        type_hint.className = 'type-hint';
        type_hint.appendChild(document.createTextNode(elem.type));
        th.appendChild(type_hint);
        appendHeaderResizer(th);
        th.style.zIndex = zIndex;
        --zIndex;
        thead.appendChild(th);

        column_is_number[elem.name] = !!elem.type.match(/^(Nullable\()?(U?Int|Decimal|Float)/);
    });

    let table = getCurrentDataTable();
    while (table.firstChild) {
        table.removeChild(table.lastChild);
    }
    let tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);
    table.style.display = 'table';
    getCurrentDataDiv().style.display = 'block';

    row_idx = 0;
}

const max_rows = 1_000;
const max_cells = 100_000;

let current_selected_cell = null;
function appendRow(row, fragment) {
    if (row_idx >= max_rows || (1 + row_idx) * Object.keys(header).length > max_cells) {
        markResultIncomplete();
        return false;
    }

    ++row_idx;
    let tr = document.createElement('tr');

    let td = document.createElement('td');
    td.className = 'row-number';
    td.appendChild(document.createTextNode(row_idx));
    tr.appendChild(td);

    let col_idx = 0;
    for (const column of header) {
        const td = renderCell(column.name, row[column.name]);
        ++col_idx;

        td.onclick = () => {
            selectResultCell(td);
        };

        tr.appendChild(td);
    }

    fragment.appendChild(tr);
    incomplete_result = false;
    return true;
}

function renderExtremes() {
    let col_idx = 0;
    for (const column of header) {
        const name = column.name;
        ++col_idx;
        if (column_is_number[name]
            && extremes.min[name] !== undefined && extremes.max[name] !== undefined
            && Number(extremes.max[name]) > Number(extremes.min[name])) {
            let table = getCurrentDataTable();

            const double_sided = extremes.min[name] < 0;
            const ratio_positive = extremes.max[name] / (extremes.max[name] - extremes.min[name]);
            const ratio_negative = 1 - ratio_positive;

            for (let row of table.rows) {
                let cell = row.cells[col_idx];
                let value = +cell.innerText;

                if (!double_sided) {
                    if (value > 0) {
                        const ratio = value / extremes.max[name];

                        cell.style.cssText = `
                            background-size: 100% 50%;
                            background-position: center;
                            background-repeat: no-repeat;
                            background: linear-gradient(to right,
                                var(--bar-color) 0%, var(--bar-color) ${100 * ratio}%,
                                var(--element-background-color) ${100 * ratio}%, var(--element-background-color) 100%)`;
                    }
                } else {
                    if (value > 0) {
                        const ratio = value / extremes.max[name];

                        cell.style.cssText = `
                            background-size: 100% 50%;
                            background-position: center;
                            background-repeat: no-repeat;
                            background: linear-gradient(to right,
                                var(--element-background-color) 0%, var(--element-background-color) ${100 * ratio_negative}%,
                                var(--bar-color) ${100 * ratio_negative}%, var(--bar-color) ${100 * (ratio_negative + ratio * ratio_positive)}%,
                                var(--element-background-color) ${100 * (ratio_negative + ratio * ratio_positive)}%, var(--element-background-color) 100%)`;
                    } else if (value < 0) {
                        const ratio = value / extremes.min[name];

                        cell.style.cssText = `
                            background-size: 100% 50%;
                            background-position: center;
                            background-repeat: no-repeat;
                            background: linear-gradient(to right,
                                var(--element-background-color) 0%, var(--element-background-color) ${100 * (1 - ratio) * ratio_negative}%,
                                var(--bar-color-negative) ${100 * (1 - ratio) * ratio_negative}%, var(--bar-color-negative) ${100 * ratio_negative}%,
                                var(--element-background-color) ${100 * ratio_negative}%, var(--element-background-color) 100%)`;
                    }
                }
            }
        }
    }
}

function renderError(message)
{
    const error_elem = getCurrentError();
    error_elem.innerText = message ? message : "No response.";
    error_elem.style.display = 'block';
}
