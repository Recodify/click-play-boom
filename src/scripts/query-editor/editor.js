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

const query_editor_indent = '    ';
let query_editor_tab_exit_armed = false;

function getQueryEditorLineRange(value, selection_start, selection_end) {
    const line_start = value.lastIndexOf('\n', selection_start - 1) + 1;
    const ends_at_next_line_start = selection_end > selection_start && value[selection_end - 1] == '\n';
    const line_end_search_start = ends_at_next_line_start ? selection_end - 1 : selection_end;
    const next_line_break = value.indexOf('\n', line_end_search_start);

    return {
        start: line_start,
        end: next_line_break == -1 ? value.length : next_line_break
    };
}

function mapQueryEditorOffsetAfterPrefixChanges(offset, changes) {
    let delta = 0;

    for (const change of changes) {
        if (offset <= change.start) {
            break;
        }

        if (change.remove > 0 && offset < change.start + change.remove) {
            return change.start + delta + change.insert;
        }

        delta += change.insert - change.remove;
    }

    return offset + delta;
}

function indentSelectedQueryEditorLines() {
    const value = query_area.value;
    const selection_start = query_area.selectionStart ?? 0;
    const selection_end = query_area.selectionEnd ?? selection_start;
    const range = getQueryEditorLineRange(value, selection_start, selection_end);
    const lines = value.substring(range.start, range.end).split('\n');
    const changes = [];
    let line_start = range.start;

    const replacement = lines.map(line => {
        changes.push({ start: line_start, remove: 0, insert: query_editor_indent.length });
        line_start += line.length + 1;
        return query_editor_indent + line;
    }).join('\n');

    replaceQueryEditorRange(
        replacement,
        range.start,
        range.end,
        mapQueryEditorOffsetAfterPrefixChanges(selection_start, changes),
        mapQueryEditorOffsetAfterPrefixChanges(selection_end, changes));
}

function getQueryEditorOutdentLength(line) {
    if (line.startsWith('\t')) {
        return 1;
    }

    return line.match(/^ {0,4}/)[0].length;
}

function outdentQueryEditorLines() {
    const value = query_area.value;
    const selection_start = query_area.selectionStart ?? 0;
    const selection_end = query_area.selectionEnd ?? selection_start;
    const range = getQueryEditorLineRange(value, selection_start, selection_end);
    const lines = value.substring(range.start, range.end).split('\n');
    const changes = [];
    let line_start = range.start;

    const replacement = lines.map(line => {
        const remove = getQueryEditorOutdentLength(line);
        changes.push({ start: line_start, remove, insert: 0 });
        line_start += line.length + 1;
        return line.substring(remove);
    }).join('\n');

    if (replacement == value.substring(range.start, range.end)) {
        return;
    }

    replaceQueryEditorRange(
        replacement,
        range.start,
        range.end,
        mapQueryEditorOffsetAfterPrefixChanges(selection_start, changes),
        mapQueryEditorOffsetAfterPrefixChanges(selection_end, changes));
}

function isQueryEditorModifierKey(key) {
    return ['Alt', 'Control', 'Meta', 'Shift'].includes(key);
}

function clearQueryEditorTabExitArm() {
    query_editor_tab_exit_armed = false;
}

function handleQueryEditorKeyDown(e) {
    if (e.defaultPrevented) {
        return;
    }

    if (e.key == 'Escape' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        query_editor_tab_exit_armed = true;
        return;
    }

    if (e.key == 'Tab') {
        if (query_editor_tab_exit_armed) {
            query_editor_tab_exit_armed = false;
            return;
        }

        if (e.altKey || e.ctrlKey || e.metaKey) {
            return;
        }

        e.preventDefault();
        if (e.shiftKey) {
            outdentQueryEditorLines();
        } else if (query_area.selectionStart !== query_area.selectionEnd) {
            indentSelectedQueryEditorLines();
        } else {
            replaceQueryEditorRange(query_editor_indent);
        }
        return false;
    }

    if (!isQueryEditorModifierKey(e.key)) {
        query_editor_tab_exit_armed = false;
    }

    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
        // If the user presses Enter, and the previous line starts with spaces,
        // then we will insert the same number of spaces.
        const elem = e.target;
        if (elem.selectionStart !== elem.selectionEnd) {
            // If there is a selection, then we will not insert spaces.
            return;
        }
        const cursor_pos = elem.selectionStart;

        const elem_value = elem.value;
        const text_before_cursor = elem_value.substring(0, cursor_pos);
        const prev_lines = text_before_cursor.split('\n');
        const prev_line = prev_lines.pop();
        const lead_spaces = prev_line.match(/^\s*/)[0];
        if (!lead_spaces) {
            return;
        }

        e.preventDefault();
        replaceQueryEditorRange('\n' + lead_spaces, cursor_pos, cursor_pos);
        return false;
    } else if ((e.ctrlKey || e.metaKey) && e.key === '/' && !e.shiftKey) {
        // Comment/uncomment selected lines on Ctrl+/ or Cmd+/
        const elem = e.target;
        const start = elem.selectionStart;
        const end = elem.selectionEnd;
        const value = elem.value;

        let lineStart = value.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = value.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = value.length;

        let selectedText = value.substring(lineStart, lineEnd);
        let lines = selectedText.split('\n');

        // Comment out each line, or uncomment if all lines are already commented
        const allCommented = lines.every(line => /^\s*--/.test(line));

        // If all lines are commented out, uncomment them
        if (allCommented) {
            lines = lines.map(line => line.replace(/^(\s*)-- ?/, '$1'));
        } else {
            lines = lines.map(line => {
                if (/^\s*$/.test(line)) {
                    return line;
                }
                return line.replace(/^(\s*)/, '$1-- ');
            });
        }

        const replacedText = lines.join('\n');

        e.preventDefault();
        // Adjust selection to keep the user in flow and enable quick reversal
        replaceQueryEditorRange(replacedText, lineStart, lineEnd, lineStart, lineStart + replacedText.length);
        return false;
    }
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
