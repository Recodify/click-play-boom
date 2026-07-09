function normaliseInsertionMode(mode, fallback = 'append') {
    return ['append', 'insert', 'overwrite'].includes(mode) ? mode : fallback;
}

function isRunnableSqlInsertion(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) {
        return false;
    }

    return /^(ALTER|ATTACH|BACKUP|CHECK|CREATE|DELETE|DESC|DESCRIBE|DETACH|DROP|EXISTS|EXPLAIN|INSERT|KILL|OPTIMIZE|RENAME|RESTORE|SELECT|SET|SHOW|SYSTEM|TRUNCATE|USE|WATCH|WITH)\b/i.test(trimmed);
}

function rememberQueryEditorSelection() {
    const value_length = query_area.value.length;
    const start = Math.max(0, Math.min(query_area.selectionStart ?? value_length, value_length));
    const end = Math.max(0, Math.min(query_area.selectionEnd ?? start, value_length));
    insertion_manager.last_selection_start = start;
    insertion_manager.last_selection_end = end;
}

function getRememberedQueryEditorSelection() {
    const value_length = query_area.value.length;
    return {
        start: Math.max(0, Math.min(insertion_manager.last_selection_start, value_length)),
        end: Math.max(0, Math.min(insertion_manager.last_selection_end, value_length))
    };
}

function replaceQueryEditorRange(text, start = query_area.selectionStart ?? query_area.value.length, end = query_area.selectionEnd ?? query_area.value.length, selection_start = null, selection_end = null, options = {}) {
    query_area.focus();
    query_area.setSelectionRange(start, end);

    let inserted = false;
    const value_before_insert = query_area.value;
    if (typeof document.execCommand == 'function') {
        try {
            suppress_programmatic_query_input = true;
            inserted = document.execCommand('insertText', false, text);
        } catch (e) {
            inserted = false;
        } finally {
            suppress_programmatic_query_input = false;
        }
    }

    if (!inserted && query_area.value != value_before_insert) {
        inserted = true;
    }

    if (!inserted) {
        query_area.setRangeText(text, start, end, 'end');
    }

    if (selection_start !== null && selection_end !== null) {
        query_area.setSelectionRange(selection_start, selection_end);
    }

    rememberQueryEditorSelection();
    updateRunButtonText();
    scheduleQueryHighlighting(String(text || '').length > large_editor_insert_threshold || options.defer_highlighting);
    refreshAutocompleteFromEditor();
}

function insertIntoQueryEditor(text, options = {}) {
    const text_value = String(text || '');
    const mode = normaliseInsertionMode(options.mode);
    const value_length = query_area.value.length;
    let start = value_length;
    let end = value_length;
    let text_to_insert = text_value;
    let inserted_text_start = start;
    const select_inserted = options.select_inserted ?? options.selectInserted ?? false;

    if (mode == 'append') {
        const prefix = query_area.value.trim() ? '\n\n' : '';
        text_to_insert = `${prefix}${text_value}`;
        inserted_text_start = start + prefix.length;
    } else if (mode == 'overwrite') {
        start = 0;
        end = value_length;
        inserted_text_start = 0;
    } else {
        const selection = document.activeElement == query_area
            ? {
                start: query_area.selectionStart ?? value_length,
                end: query_area.selectionEnd ?? query_area.selectionStart ?? value_length
            }
            : getRememberedQueryEditorSelection();
        start = selection.start;
        end = selection.end;
        inserted_text_start = start;
    }

    const inserted_text_end = inserted_text_start + text_value.length;
    replaceQueryEditorRange(
        text_to_insert,
        start,
        end,
        select_inserted ? inserted_text_start : null,
        select_inserted ? inserted_text_end : null);
}

function insertTextIntoEditor(text, options = {}) {
    insertIntoQueryEditor(text, {
        mode: 'append',
        select_inserted: options.select_inserted ?? options.selectInserted ?? isRunnableSqlInsertion(text)
    });
}

function insertSnippetIntoQueryEditor(text, mode) {
    insertIntoQueryEditor(text, {
        mode: mode,
        select_inserted: isRunnableSqlInsertion(text)
    });
}

function setSnippetInsertionMode(mode, save = true) {
    insertion_manager.snippet_mode = normaliseInsertionMode(mode);
    snippet_insertion_mode_elem.value = insertion_manager.snippet_mode;
    if (save) {
        window.localStorage.setItem(snippet_insertion_mode_key, insertion_manager.snippet_mode);
    }
}

function getSnippetInsertionMode() {
    return insertion_manager.snippet_mode;
}
