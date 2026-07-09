// Download functionality
let last_query_for_download = '';
const download_format_extensions = new Map([
    ['csv', 'csv'],
    ['csvwithnames', 'csv'],
    ['csvwithnamesandtypes', 'csv'],
    ['tsv', 'tsv'],
    ['tsvwithnames', 'tsv'],
    ['tsvwithnamesandtypes', 'tsv'],
    ['tabseparated', 'tsv'],
    ['tabseparatedwithnames', 'tsv'],
    ['tabseparatedwithnamesandtypes', 'tsv'],
    ['json', 'json'],
    ['jsonlines', 'jsonl'],
    ['ndjson', 'jsonl'],
    ['parquet', 'parquet'],
    ['markdown', 'md'],
    ['xml', 'xml'],
    ['yaml', 'yaml'],
    ['sqlinsert', 'sql'],
    ['tskv', 'tskv'],
    ['native', 'native'],
    ['rowbinary', 'bin'],
    ['rawblob', 'blob'],
    ['arrow', 'arrow'],
    ['arrowstream', 'arrow'],
    ['avro', 'avro'],
    ['orc', 'orc'],
    ['protobuf', 'protobuf'],
    ['capnproto', 'capnp'],
    ['bson', 'bson'],
    ['msgpack', 'msgpack']
]);
const known_download_extensions = new Set([
    ...download_format_extensions.values(),
    'txt'
]);

function normalizeDownloadFormatName(format) {
    return (format || '').trim().toLowerCase();
}

function getSelectedDownloadFormat() {
    const format_select = document.getElementById('download-format');
    const format_other = document.getElementById('download-format-other');
    const selected_format = format_select.value;
    return selected_format == 'other' ? format_other.value.trim() : selected_format;
}

function getDownloadFormatExtension(format) {
    const normalized_format = normalizeDownloadFormatName(format);
    if (!normalized_format) {
        return 'txt';
    }

    const mapped_extension = download_format_extensions.get(normalized_format);
    if (mapped_extension) {
        return mapped_extension;
    }

    if (normalized_format.startsWith('csv')) {
        return 'csv';
    }

    if (normalized_format.startsWith('tsv') || normalized_format.startsWith('tabseparated')) {
        return 'tsv';
    }

    if (normalized_format.startsWith('json')) {
        return normalized_format.includes('eachrow') || normalized_format.includes('lines')
            ? 'jsonl'
            : 'json';
    }

    if (normalized_format.startsWith('pretty') || normalized_format == 'vertical' || normalized_format == 'values') {
        return 'txt';
    }

    return normalized_format.replace(/[^a-z0-9]+/g, '') || 'txt';
}

function stripClickHouseIdentifierQuotes(identifier_part) {
    const trimmed = (identifier_part || '').trim();
    if (trimmed.length >= 2 && trimmed[0] == '`' && trimmed[trimmed.length - 1] == '`') {
        return trimmed.slice(1, -1).replaceAll('``', '`');
    }
    if (trimmed.length >= 2 && trimmed[0] == '"' && trimmed[trimmed.length - 1] == '"') {
        return trimmed.slice(1, -1).replaceAll('""', '"');
    }
    return trimmed;
}

function getDownloadBasenameFromQuery(query) {
    const identifier = '`(?:``|[^`])+`|"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*';
    const match = query.match(new RegExp(`\\bFROM\\s+(${identifier}(?:\\s*\\.\\s*${identifier})?)`, 'i'));
    if (!match) {
        return 'results';
    }

    const parts = match[1].split(/\s*\.\s*/).map(stripClickHouseIdentifierQuotes);
    return parts[parts.length - 1] || 'results';
}

function sanitizeDownloadFilenamePart(value) {
    return (value || '')
        .trim()
        .replace(/[\x00-\x1F\x7F<>:"'\/\\|?*]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')
        .replace(/[. -]+$/g, '')
        .slice(0, 120);
}

function stripKnownDownloadExtension(filename) {
    const match = filename.match(/\.([A-Za-z0-9]+)$/);
    if (match && known_download_extensions.has(match[1].toLowerCase())) {
        return filename.slice(0, -match[0].length);
    }
    return filename;
}

function buildDownloadFilename(query, format, requested_name = '') {
    const extension = getDownloadFormatExtension(format);
    let basename = sanitizeDownloadFilenamePart(requested_name);
    if (!basename) {
        basename = sanitizeDownloadFilenamePart(getDownloadBasenameFromQuery(query));
    }
    if (!basename) {
        basename = 'results';
    }

    return `${stripKnownDownloadExtension(basename)}.${extension}`;
}

function updateDownloadFormatOtherVisibility() {
    const format_select = document.getElementById('download-format');
    const format_other = document.getElementById('download-format-other');
    if (format_select.value == 'other') {
        format_other.classList.add('show');
        format_other.focus();
    } else {
        format_other.classList.remove('show');
    }
}

function updateDownloadFilenamePlaceholder() {
    const filename_input = document.getElementById('download-filename');
    if (!filename_input) {
        return;
    }

    filename_input.placeholder = buildDownloadFilename(
        last_query_for_download || query_area.value,
        getSelectedDownloadFormat() || 'Custom',
        ''
    );
}

function openDownloadDropdown(button) {
    const dropdown = document.getElementById('download-dropdown');
    const context = document.getElementById('main');

    if (dropdown.classList.contains('show')) {
        dropdown.classList.remove('show');
    } else {
        // Position the dropdown relative to the button
        dropdown.classList.add('show');
        const button_rect = button.getBoundingClientRect();
        const context_rect = context.getBoundingClientRect();
        const dropdown_rect = dropdown.getBoundingClientRect();
        const preferred_left = button_rect.left - context_rect.left;
        const max_left = Math.max(0, context_rect.width - dropdown_rect.width);

        dropdown.style.top = (button_rect.bottom - context_rect.top + 4) + 'px';
        dropdown.style.left = Math.min(preferred_left, max_left) + 'px';
        updateDownloadFilenamePlaceholder();
    }
}

// Prevent dropdown from closing when clicking inside it
document.getElementById('download-dropdown').addEventListener('click', function(e) {
    e.stopPropagation();
});

// Close dropdown when clicking outside
document.addEventListener('click', function() {
    const dropdown = document.getElementById('download-dropdown');
    dropdown.classList.remove('show');
});

// Handle "Other" format selection
document.getElementById('download-format').addEventListener('change', function() {
    updateDownloadFormatOtherVisibility();
    updateDownloadFilenamePlaceholder();
});

document.getElementById('download-format-other').addEventListener('input', updateDownloadFilenamePlaceholder);

// Handle download button click
document.getElementById('download-button').addEventListener('click', async function() {
    const format_select = document.getElementById('download-format');
    const filename_input = document.getElementById('download-filename');

    let format = getSelectedDownloadFormat();
    if (format_select.value == 'other' && !format) {
        alert('Please enter a format name');
        return;
    }

    // Get current values
    const user = user_elem.value;
    const password = password_elem.value;
    const server_address = url_elem.value;
    const query = last_query_for_download;

    if (!query) {
        alert('No query to download results for');
        return;
    }

    const filename = buildDownloadFilename(query, format, filename_input.value);

    // Build download URL
    let url = server_address +
        (server_address.indexOf('?') >= 0 ? '&' : '?') +
        'add_http_cors_header=1' +
        '&enable_http_compression=1' +
        '&default_format=' + encodeURIComponent(format) +
        '&http_response_headers=' + encodeURIComponent(`{'Content-Disposition':'attachment; filename="${filename}"'}`);
    if (shouldUseQueryCacheForDownload()) {
        url += '&use_query_cache=1&enable_reads_from_query_cache=1&enable_writes_to_query_cache=0&query_cache_ttl=600&query_cache_nondeterministic_function_handling=save';
    }
    if (user) url += '&user=' + encodeURIComponent(user);
    if (password) url += '&password=' + encodeURIComponent(password);

    let downloadQuery = getDownloadQueryText(query);

    // Create a form and submit it to trigger download
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    form.enctype = 'multipart/form-data';
    form.style.display = 'none';

    const queryInput = document.createElement('input');
    queryInput.type = 'hidden';
    queryInput.name = 'query';
    queryInput.value = downloadQuery;
    form.appendChild(queryInput);

    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);

    // Close dropdown
    document.getElementById('download-dropdown').classList.remove('show');
});
