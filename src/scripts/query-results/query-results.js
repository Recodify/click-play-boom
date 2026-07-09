function handleLocalStorageChanged(e) {
    if (e.storageArea != window.localStorage) {
        return;
    }

    if (e.key == query_snippets_key) {
        handleQuerySnippetsChanged();
    } else if (e.key == saved_connections_key) {
        handleSavedConnectionsChanged();
    }
}

function scrollResultsToTop() {
    current_result_elements?.result_body?.scrollTo({ top: 0, left: 0 });
}

function keepResultTabVisible(result) {
    result?.tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function hasResultPanel(resultId) {
    return result_history.some(result => result.id == resultId);
}

function createResultPanel(requestNum, query) {
    const template = document.getElementById('result-panel-template');
    const panel = template.content.firstElementChild.cloneNode(true);
    const resultId = `result-${requestNum}`;
    const resultColor = queryToColor(query);
    panel.dataset.resultId = resultId;
    panel.style.setProperty('--result-color-rotate', resultColor);

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'result-tab';
    tab.dataset.resultId = resultId;
    tab.style.setProperty('--result-color-rotate', resultColor);
    const tabTitle = document.createElement('span');
    tabTitle.className = 'result-tab-title';
    tabTitle.textContent = `#${requestNum} ${query.replace(/\s+/g, ' ').slice(0, 48) || 'result'}`;
    const tabStatus = document.createElement('span');
    tabStatus.className = 'result-tab-status';
    tabStatus.textContent = '✔';
    tabStatus.hidden = true;
    tab.append(tabTitle, tabStatus);
    tab.addEventListener('click', () => activateResultPanel(resultId));

    const elements = {
        panel: panel,
        result_body: panel.querySelector('.result-body'),
        result_chrome: panel.querySelector('.result-chrome'),
        result_summary: panel.querySelector('.result-summary'),
        result_query: panel.querySelector('.result-query'),
        result_stats: panel.querySelector('.result-stats'),
        data_div: panel.querySelector('.data-div'),
        result_query_copy: panel.querySelector('.result-query-copy'),
        result_download: panel.querySelector('.result-download'),
        result_copy: panel.querySelector('.result-copy'),
        copy_text: '',
        data_table: panel.querySelector('.data-table'),
        data_unparsed: panel.querySelector('.data-unparsed'),
        chart: panel.querySelector('.chart-output'),
        graph: panel.querySelector('.graph-output'),
        error: panel.querySelector('.error-output')
    };

    attachResultStatsSelection(elements.result_stats);
    attachResultQueryCopyButton(elements);
    attachResultDownloadButton(elements, resultId);
    attachResultCopyButton(elements, resultId);

    elements.result_query.innerText = query;
    results_header_elem.hidden = false;
    results_tabs_elem.appendChild(tab);
    results_panels_elem.appendChild(panel);
    document.getElementById('logo-container').style.display = 'none';

    const meta = {
        id: resultId,
        request_num: requestNum,
        query: query,
        connection_name: current_connection_name,
        tab: tab,
        tab_status: tabStatus,
        elements: elements,
        stats: '',
        base_stats: '',
        timing_stats: '',
        query_log_stats: '',
        progress_stats: '',
        summary_stats: '',
        query_id: '',
        format: '',
        is_table: false,
        is_raw: false,
        is_chart: false,
        is_error: false,
        stats_loading: false,
        ok: false
    };

    result_history.push(meta);
    current_result_elements = elements;
    current_result_meta = meta;
    activateResultPanel(resultId);
    return meta;
}

function activateResultPanel(resultId) {
    if (!hasResultPanel(resultId)) {
        updateActiveHistoryEntry(active_result_id);
        return;
    }

    active_result_id = resultId;
    let active_result = null;
    for (const result of result_history) {
        const isActive = result.id == resultId;
        result.tab.classList.toggle('active', isActive);
        result.elements.panel.classList.toggle('active', isActive);
        if (isActive) {
            active_result = result;
            current_result_elements = result.elements;
            current_result_meta = result;
            document.getElementById('stats').innerText = result.stats || '';
            last_query_for_download = result.query;
        }
    }

    keepResultTabVisible(active_result);
    updateActiveHistoryEntry(resultId);
}

function resetResultPanels() {
    result_history = [];
    active_result_id = null;
    current_result_elements = null;
    current_result_meta = null;
    render_result_elements = null;
    render_result_meta = null;
    results_tabs_elem.innerHTML = '';
    results_panels_elem.innerHTML = '';
    results_header_elem.hidden = true;
    document.getElementById('stats').innerText = '';
    document.getElementById('logo-container').style.display = 'block';
    renderActionHistory();
}

function setResultTabStatus(result = current_result_meta, status = '') {
    if (!result?.tab_status) {
        return;
    }

    result.tab_status.hidden = !status;
    result.tab_status.textContent = status == 'success' ? '✔' : '✕';
    result.tab_status.title = status == 'success' ? 'Query succeeded' : status == 'failed' ? 'Query failed' : '';
    result.tab.classList.toggle('succeeded', status == 'success');
    result.tab.classList.toggle('failed', status == 'failed');
}

function setResultTabSucceeded(result = current_result_meta, succeeded = false) {
    setResultTabStatus(result, succeeded ? 'success' : '');
}

function setResultTabFailed(result = current_result_meta) {
    setResultTabStatus(result, 'failed');
}

function setResultDownloadButtonVisible(elements = current_result_elements, visible = false) {
    const button = elements?.result_download;
    if (!button) {
        return;
    }

    button.style.display = visible ? 'inline-flex' : 'none';
    button.disabled = !visible;
}

function attachResultDownloadButton(elements, resultId) {
    const button = elements?.result_download;
    if (!button) {
        return;
    }

    setResultDownloadButtonVisible(elements, false);
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        if (button.disabled) {
            return;
        }

        const result = result_history.find(candidate => candidate.id == resultId);
        if (!result?.ok) {
            setResultDownloadButtonVisible(elements, false);
            return;
        }

        last_query_for_download = result.query;
        openDownloadDropdown(button);
    });
}

function attachResultStatsSelection(stats) {
    if (!stats) {
        return;
    }

    ['pointerdown', 'mousedown', 'mouseup', 'dblclick'].forEach(eventName => {
        stats.addEventListener(eventName, event => {
            event.stopPropagation();
        });
    });

    stats.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
    });
}

function resetResultCopyButton(elements = current_result_elements) {
    const button = elements?.result_copy;
    if (!button) {
        return;
    }

    if (button.copy_feedback_timeout) {
        clearTimeout(button.copy_feedback_timeout);
        button.copy_feedback_timeout = null;
    }

    button.style.display = 'none';
    button.disabled = true;
    button.classList.remove('copied', 'copy-failed');
    button.copy_original_label = null;
    button.copy_original_text = null;
    button.textContent = '⧉';
    button.title = 'Copy formatted result';
    button.setAttribute('aria-label', 'Copy formatted result');
    elements.copy_text = '';
}

function showResultCopyButton(elements = current_result_elements, format = '') {
    const button = elements?.result_copy;
    if (!button) {
        return;
    }

    button.style.display = 'flex';
    button.disabled = false;
    button.title = format && format != 'result' ? `Copy ${format} result` : 'Copy result';
    button.setAttribute('aria-label', button.title);
}

function showResultCopyFeedback(button, copied) {
    if (!button) {
        return;
    }

    if (button.copy_feedback_timeout) {
        clearTimeout(button.copy_feedback_timeout);
    }

    const original_title = button.copy_original_label || button.getAttribute('aria-label') || 'Copy formatted result';
    const original_text = button.copy_original_text || button.textContent || '⧉';
    button.copy_original_label = original_title;
    button.copy_original_text = original_text;

    button.classList.toggle('copied', copied);
    button.classList.toggle('copy-failed', !copied);
    button.textContent = copied ? '✓' : '!';

    button.title = copied ? 'Copied' : 'Copy failed';
    button.setAttribute('aria-label', button.title);

    button.copy_feedback_timeout = setTimeout(() => {
        button.classList.remove('copied', 'copy-failed');
        button.textContent = original_text;
        button.title = original_title;
        button.setAttribute('aria-label', original_title);
        button.copy_original_label = null;
        button.copy_original_text = null;
        button.copy_feedback_timeout = null;
    }, 1200);
}

function attachResultQueryCopyButton(elements) {
    const button = elements?.result_query_copy;
    if (!button) {
        return;
    }

    button.style.display = 'inline-flex';
    button.disabled = false;
    button.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();

        const copied = await copyTextToClipboard(elements.result_query.textContent || '');
        showResultCopyFeedback(button, copied);
    });
}

function getDownloadQueryText(query) {
    return String(query || '').replaceAll(/\bFORMAT\s+\w+/ig, '');
}

function getResultReuseParams() {
    if (!shouldUseQueryCacheForDownload()) {
        return {};
    }

    return {
        use_query_cache: '1',
        enable_reads_from_query_cache: '1',
        enable_writes_to_query_cache: '0',
        query_cache_ttl: '600',
        query_cache_nondeterministic_function_handling: 'save'
    };
}

async function fetchResultTextAsFormat(result, format) {
    if (!result?.query) {
        throw new Error('No query is available for this result.');
    }

    const url = buildClickHouseUrl(url_elem.value, user_elem.value, password_elem.value, format, {
        enable_http_compression: '1',
        ...getResultReuseParams()
    });

    const response = await fetch(url, {
        method: 'POST',
        body: getDownloadQueryText(result.query),
        headers: { 'Authorization': 'never' }
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(text || `Failed to fetch ${format} result.`);
    }

    return text;
}

function buildQueryResultMarkdownDocument(query, markdown_result) {
    const sql = String(query || '').trim();
    const result = String(markdown_result || '').trim();
    return `\`\`\`sql\n${sql}\n\`\`\`\n\n${result}\n`;
}

async function copyResultAsFormat(result, format) {
    const button = result?.elements?.result_copy;
    try {
        const text = await fetchResultTextAsFormat(result, format);
        const copied = await copyTextToClipboard(text);
        showResultCopyFeedback(button, copied);
    } catch (e) {
        console.log(e);
        showResultCopyFeedback(button, false);
        alert(e.message || 'Copy failed.');
    }
}

async function copyQueryAndMarkdownResult(result) {
    const button = result?.elements?.result_copy;
    try {
        const markdown = await fetchResultTextAsFormat(result, 'Markdown');
        const copied = await copyTextToClipboard(buildQueryResultMarkdownDocument(result.query, markdown));
        showResultCopyFeedback(button, copied);
    } catch (e) {
        console.log(e);
        showResultCopyFeedback(button, false);
        alert(e.message || 'Copy failed.');
    }
}

function downloadTextFile(filename, text, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

async function downloadQueryAndMarkdownResult(result) {
    const button = result?.elements?.result_copy;
    try {
        const markdown = await fetchResultTextAsFormat(result, 'Markdown');
        const document_text = buildQueryResultMarkdownDocument(result.query, markdown);
        const filename = buildDownloadFilename(result.query, 'Markdown', `${getDownloadBasenameFromQuery(result.query)}-query-result`);
        downloadTextFile(filename, document_text, 'text/markdown;charset=utf-8');
        showResultCopyFeedback(button, true);
    } catch (e) {
        console.log(e);
        showResultCopyFeedback(button, false);
        alert(e.message || 'Download failed.');
    }
}

function openResultCopyMenu(anchor_rect, result) {
    const items = result?.is_table ? [
        {
            icon: '⧉',
            label: 'Copy result as Markdown',
            onClick: () => copyResultAsFormat(result, 'Markdown')
        },
        {
            icon: '⧉',
            label: 'Copy result as CSV',
            onClick: () => copyResultAsFormat(result, 'CSVWithNames')
        },
        {
            icon: '⧉',
            label: 'Copy result as TSV',
            onClick: () => copyResultAsFormat(result, 'TSVWithNames')
        },
        {
            icon: '▣',
            label: 'Copy query + result Markdown',
            onClick: () => copyQueryAndMarkdownResult(result)
        },
        {
            icon: '⇩',
            label: 'Download query + result Markdown',
            onClick: () => downloadQueryAndMarkdownResult(result)
        }
    ] : [];

    if (!items.length && (result?.elements?.copy_text || result?.elements?.data_unparsed?.textContent)) {
        items.push({
            icon: '⧉',
            label: 'Copy rendered result',
            onClick: async () => {
                const copied = await copyTextToClipboard(result.elements.copy_text || result.elements.data_unparsed.textContent || '');
                showResultCopyFeedback(result.elements.result_copy, copied);
            }
        });
    }

    if (!items.length) {
        return;
    }

    showNavigatorContextMenu(items, anchor_rect.right, anchor_rect.bottom + 4, { align: 'right' });
}

function attachResultCopyButton(elements, resultId) {
    const button = elements?.result_copy;
    if (!button) {
        return;
    }

    resetResultCopyButton(elements);
    button.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();

        if (button.disabled) {
            return;
        }

        const result = result_history.find(candidate => candidate.id == resultId);
        if (!result?.ok) {
            resetResultCopyButton(elements);
            return;
        }

        openResultCopyMenu(button.getBoundingClientRect(), result);
    });
}

function renderActionHistory() {
    action_body.replaceChildren();

    if (!action_history.length) {
        action_history_empty_elem.style.display = 'block';
        return;
    }

    action_history_empty_elem.style.display = 'none';

    for (const entry of [...action_history].reverse()) {
        const row = document.createElement('div');
        row.className = 'history-entry';
        row.dataset.resultId = entry.result_id;
        const result_available = hasResultPanel(entry.result_id);

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'history-entry-main';
        if (!result_available) {
            main.setAttribute('aria-disabled', 'true');
        }
        main.title = result_available ? entry.query : `${entry.query}\n\nResult is no longer open.`;
        main.addEventListener('click', () => {
            if (result_available) {
                activateResultPanel(entry.result_id);
            }
        });

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'history-entry-copy';
        copy.textContent = '⧉';
        copy.title = `Copy query\n\n${entry.query}`;
        copy.setAttribute('aria-label', `Copy query #${entry.request_num}`);
        copy.addEventListener('click', async e => {
            e.stopPropagation();
            const copied = await copyTextToClipboard(entry.query);
            if (!copied) {
                return;
            }

            copy.classList.add('copied');
            copy.textContent = '✓';
            window.setTimeout(() => {
                copy.classList.remove('copied');
                copy.textContent = '⧉';
            }, 1200);
        });

        const meta = document.createElement('div');
        meta.className = 'history-entry-meta';

        const number = document.createElement('span');
        number.className = 'history-entry-number';
        number.textContent = `#${entry.request_num}`;

        const status = document.createElement('span');
        status.className = `history-entry-status ${entry.ok ? 'ok' : 'fail'}`;
        status.textContent = entry.ok ? '✔' : '✘';

        const connection = document.createElement('span');
        connection.className = 'history-entry-connection';
        connection.textContent = entry.connection_name;

        const query = document.createElement('span');
        query.className = 'history-entry-query monospace';
        query.textContent = entry.query;
        query.title = entry.query;

        const detail = document.createElement('div');
        detail.className = 'history-entry-detail';

        const message = document.createElement('span');
        message.className = 'history-entry-message';
        message.textContent = entry.message;

        const stats = document.createElement('span');
        stats.className = 'history-entry-stats';
        stats.textContent = entry.stats || '-';

        meta.append(number, status, connection);
        detail.append(message, stats);
        main.append(meta, query, detail);
        row.append(main, copy);
        action_body.appendChild(row);
    }

    updateActiveHistoryEntry(active_result_id);
}

function updateActiveHistoryEntry(resultId) {
    for (const entry of action_body.querySelectorAll('.history-entry')) {
        entry.classList.toggle('active', !!resultId && entry.dataset.resultId == resultId);
    }
}
