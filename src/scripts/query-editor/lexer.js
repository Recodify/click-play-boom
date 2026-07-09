let lexer_module;
async function loadLexer() {
    // base64 -w0 build/src/Parsers/Lexer.wasm
    const lexer_base64 = "__CLICKHOUSE_LEXER_WASM_BASE64__";

    if (!lexer_module) {
        const binary = atob(lexer_base64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        lexer_module = await WebAssembly.instantiate(bytes);
    }
}

async function tokenize(query) {
    await loadLexer();

    let exports = lexer_module.instance.exports;
    let buffer = exports.memory.buffer;
    let memory_offset = 0;

    /// Allocate memory for the lexer object
    const lexer = new Uint8Array(buffer, memory_offset, exports.clickhouse_lexer_size);
    memory_offset += exports.clickhouse_lexer_size;

    /// Allocate the query
    const bytes = new TextEncoder().encode(query);
    const query_array = new Uint8Array(buffer, memory_offset, bytes.length);
    query_array.set(bytes);
    const query_begin = memory_offset;
    memory_offset += bytes.length;
    const query_end = memory_offset;

    /// Initialize the lexer
    exports.clickhouse_lexer_create(lexer, query_begin, query_end, 65536);

    /// Allocate the out ptrs
    const token_begin = memory_offset;
    memory_offset += 4;
    const token_end = memory_offset;
    memory_offset += 4;

    let result = [];

    while (true) {
        const token_type = exports.clickhouse_lexer_next_token(lexer, token_begin, token_end);
        if (exports.clickhouse_lexer_token_is_error(token_type) || exports.clickhouse_lexer_token_is_end(token_type)) {
            break;
        }

        const view = new DataView(buffer);
        const begin = view.getUint32(token_begin, true);
        const end = view.getUint32(token_end, true);

        const token_bytes = new Uint8Array(buffer, begin, end - begin);
        let token = new TextDecoder().decode(token_bytes);

        result.push({type: token_type, significant: exports.clickhouse_lexer_token_is_significant(token_type), token: token});
    }

    return result;
}

async function getQueryUnderCursor() {
    const all_queries = query_area.value;

    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        return all_queries;
    }

    const tokens = await tokenize(all_queries);

    const cursor_position = query_area.selectionStart;
    let current_query_start = 0;
    let current_offset = 0;

    for (const elem of tokens) {
        if (current_query_start == current_offset && !elem.significant) {
            current_query_start += elem.token.length;
        }
        current_offset += elem.token.length;
        if (elem.token == ';') {
            if (current_offset >= cursor_position) {
                query_area.setSelectionRange(current_query_start, current_offset);
                query_area.focus();
                return all_queries.substring(current_query_start, current_offset);
            } else {
                current_query_start = current_offset;
            }
        }

    }

    return all_queries;
}

async function getQueriesToRun(script) {
    if (!script.trim()) {
        return [];
    }

    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        return script.split(';').map(query => query.trim()).filter(Boolean);
    }

    const tokens = await tokenize(script);
    let current_query_start = 0;
    let current_offset = 0;
    let queries = [];

    for (const elem of tokens) {
        if (current_query_start == current_offset && !elem.significant) {
            current_query_start += elem.token.length;
        }

        current_offset += elem.token.length;
        if (elem.token == ';') {
            const query = script.substring(current_query_start, current_offset).trim();
            if (query) {
                queries.push(query);
            }
            current_query_start = current_offset;
        }
    }

    const trailing_query = script.substring(current_query_start).trim();
    if (trailing_query) {
        queries.push(trailing_query);
    }

    return queries;
}

let query_highlight_generation = 0;

function disableQueryBackdrop() {
    query_backdrop_elem.style.display = 'none';
    query_backdrop_elem.innerHTML = '';
    query_area.classList.remove('has-backdrop');
}

function escapeHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TT = {
    Whitespace: 0, Comment: 1, BareWord: 2, Number: 3, StringLiteral: 4, QuotedIdentifier: 5,
    OpeningRoundBracket: 6,
    Asterisk: 16, HereDoc: 17, DollarSign: 18,
    Plus: 19, Minus: 20, Slash: 21, Percent: 22, Arrow: 23,
    QuestionMark: 24, Colon: 25, Caret: 26, DoubleColon: 27,
    Equals: 28, NotEquals: 29, Less: 30, Greater: 31,
    LessOrEquals: 32, GreaterOrEquals: 33, Spaceship: 34,
    PipeMark: 35, Concatenation: 36, At: 37, DoubleAt: 38,
};

const SQL_KEYWORDS = new Set([
    'ADD', 'AFTER', 'ALL', 'ALTER', 'AND', 'ANTI', 'ANY', 'ARRAY', 'AS', 'ASC', 'ASCENDING',
    'ASOF', 'AST', 'ASYNC', 'ATTACH', 'BACKUP', 'BEGIN', 'BETWEEN', 'BOTH', 'BY',
    'CACHE', 'CASCADE', 'CASE', 'CAST', 'CHANGE', 'CHANGED', 'CHECK', 'CLEAR', 'CLUSTER',
    'CODEC', 'COLLATE', 'COLUMN', 'COLUMNS', 'COMMENT', 'COMMIT', 'CONSTRAINT', 'CREATE',
    'CROSS', 'CUBE', 'CURRENT',
    'DATABASE', 'DATABASES', 'DAY', 'DEDUPLICATE', 'DEFAULT', 'DELETE', 'DESC', 'DESCENDING',
    'DESCRIBE', 'DETACH', 'DICTIONARIES', 'DICTIONARY', 'DISK', 'DISTINCT', 'DISTRIBUTED',
    'DROP', 'ELSE', 'END', 'ENGINE', 'ESTIMATE', 'EVENTS', 'EXCEPT', 'EXCHANGE', 'EXISTS',
    'EXPLAIN', 'EXPRESSION', 'EXTENDED', 'EXTRACT',
    'FALSE', 'FETCH', 'FETCHES', 'FILE', 'FILESYSTEM', 'FINAL', 'FIRST', 'FLUSH', 'FOLLOWING',
    'FOR', 'FOREIGN', 'FORMAT', 'FREEZE', 'FROM', 'FULL', 'FUNCTION',
    'GLOBAL', 'GRANT', 'GROUP', 'GROUPS', 'HAVING', 'HIERARCHICAL', 'HOUR',
    'ID', 'IDENTIFIED', 'IF', 'ILIKE', 'IN', 'INDEX', 'INF', 'INHERIT', 'INJECTIVE',
    'INNER', 'INSERT', 'INTERSECT', 'INTERVAL', 'INTO', 'INVISIBLE', 'IS', 'IS_OBJECT_ID',
    'JOIN', 'KEY', 'KEYED', 'KILL',
    'LAST', 'LATERAL', 'LAYOUT', 'LEADING', 'LEFT', 'LIFETIME', 'LIKE', 'LIMIT', 'LIMITS',
    'LIVE', 'LOCAL', 'LOGS',
    'MATERIALIZE', 'MATERIALIZED', 'MAX', 'MERGES', 'MICROSECOND', 'MILLISECOND', 'MIN',
    'MINUTE', 'MODIFY', 'MONTH', 'MOVE', 'MUTATION',
    'NAN_SQL', 'NEXT', 'NO', 'NONE', 'NOT', 'NULL', 'NULLS',
    'OFFSET', 'ON', 'ONLY', 'OPTIMIZE', 'OPTION', 'OR', 'ORDER', 'OUTER', 'OUTFILE', 'OVER',
    'PARTITION', 'PASTE', 'PERMANENTLY', 'PLAN', 'POPULATE', 'PRECEDING', 'PRECISION',
    'PREWHERE', 'PRIMARY', 'PROFILE', 'PROJECTION', 'QUARTER', 'QUERY', 'QUOTA',
    'RANDOMIZED', 'RANGE', 'RECURSIVE', 'REFRESH', 'REGEXP', 'RELOAD', 'REMOTE', 'RENAME',
    'REPLACE', 'REPLICA', 'REPLICAS', 'RESET', 'RESTORE', 'RESTRICT', 'RESTRICTIVE',
    'RETURNS', 'REVOKE', 'RIGHT', 'ROLE', 'ROLLBACK', 'ROLLUP', 'ROW', 'ROWS',
    'SAMPLE', 'SECOND', 'SELECT', 'SEMI', 'SENDS', 'SET', 'SETS', 'SETTINGS', 'SHARD',
    'SHOW', 'SIGNED', 'SOURCE', 'SQL_SECURITY', 'START', 'STEP', 'STORAGE', 'STRICT',
    'STRICTLY_ASCENDING', 'SUBPARTITION', 'SUBSTRING', 'SUSPEND', 'SYNC', 'SYNTAX', 'SYSTEM',
    'TABLE', 'TABLES', 'TEMPORARY', 'TEST', 'THEN', 'TIES', 'TIMESTAMP', 'TO', 'TOP',
    'TOTALS', 'TRACKING', 'TRAILING', 'TRANSACTION', 'TRIGGER', 'TRIM', 'TRUE', 'TRUNCATE',
    'TYPE',
    'UNBOUNDED', 'UNFREEZE', 'UNION', 'UNIQUE', 'UNSIGNED', 'UPDATE', 'USE', 'USING',
    'UUID', 'VALUES', 'VARYING', 'VIEW', 'VIRTUAL', 'VISIBLE',
    'WATCH', 'WEEK', 'WHEN', 'WHERE', 'WINDOW', 'WITH', 'WORK', 'WRITABLE',
    'XOR', 'YEAR', 'ZKPATH',
]);

function tokenClass(tokens, i) {
    const elem = tokens[i];
    switch (elem.type) {
        case TT.Comment: return 'q-com';
        case TT.Number: return 'q-num';
        case TT.StringLiteral:
        case TT.HereDoc: return 'q-str';
        case TT.QuotedIdentifier: return 'q-qid';
        case TT.BareWord: {
            if (SQL_KEYWORDS.has(elem.token.toUpperCase())) return 'q-kw';
            for (let j = i + 1; j < tokens.length; ++j) {
                if (tokens[j].type === TT.Whitespace) continue;
                return tokens[j].type === TT.OpeningRoundBracket ? 'q-fn' : 'q-id';
            }
            return 'q-id';
        }
        case TT.Asterisk: case TT.Plus: case TT.Minus: case TT.Slash: case TT.Percent:
        case TT.Arrow: case TT.QuestionMark: case TT.Colon: case TT.DoubleColon: case TT.Caret:
        case TT.Equals: case TT.NotEquals:
        case TT.Less: case TT.Greater: case TT.LessOrEquals: case TT.GreaterOrEquals:
        case TT.Spaceship: case TT.PipeMark: case TT.Concatenation:
        case TT.At: case TT.DoubleAt: case TT.DollarSign:
            return 'q-op';
        default:
            return '';
    }
}

function syncQueryBackdropScroll() {
    if (query_backdrop_elem.style.display == 'none') {
        return;
    }

    query_backdrop_elem.scrollTop = query_area.scrollTop;
    query_backdrop_elem.scrollLeft = query_area.scrollLeft;
}

function syncQueryBackdropLayout() {
    if (query_backdrop_elem.style.display == 'none') {
        return;
    }

    const style = getComputedStyle(query_area);
    query_backdrop_elem.style.left = `${query_area.offsetLeft}px`;
    query_backdrop_elem.style.top = `${query_area.offsetTop}px`;
    query_backdrop_elem.style.width = `${query_area.offsetWidth}px`;
    query_backdrop_elem.style.height = `${query_area.offsetHeight}px`;
    query_backdrop_elem.style.fontFamily = style.fontFamily;
    query_backdrop_elem.style.fontSize = style.fontSize;
    query_backdrop_elem.style.fontWeight = style.fontWeight;
    query_backdrop_elem.style.fontStyle = style.fontStyle;
    query_backdrop_elem.style.lineHeight = style.lineHeight;
    query_backdrop_elem.style.letterSpacing = style.letterSpacing;
    query_backdrop_elem.style.textTransform = style.textTransform;
    query_backdrop_elem.style.tabSize = style.tabSize;
    query_backdrop_elem.style.whiteSpace = style.whiteSpace;
    query_backdrop_elem.style.wordWrap = style.wordWrap;
    query_backdrop_elem.style.overflowWrap = style.overflowWrap;
    query_backdrop_elem.style.paddingTop = style.paddingTop;
    query_backdrop_elem.style.paddingBottom = style.paddingBottom;
    query_backdrop_elem.style.paddingLeft = style.paddingLeft;
    query_backdrop_elem.style.borderTopWidth = style.borderTopWidth;
    query_backdrop_elem.style.borderRightWidth = style.borderRightWidth;
    query_backdrop_elem.style.borderBottomWidth = style.borderBottomWidth;
    query_backdrop_elem.style.borderLeftWidth = style.borderLeftWidth;

    const scrollbar_width = query_area.offsetWidth - query_area.clientWidth - 2;
    query_backdrop_elem.style.paddingRight = scrollbar_width > 0
        ? `calc(${style.paddingRight} + ${scrollbar_width}px)`
        : style.paddingRight;
    syncQueryBackdropScroll();
}

function renderQueryBackdrop(text, tokens) {
    if (!text || !tokens.length) {
        disableQueryBackdrop();
        return;
    }

    let html = '';
    let offset = 0;

    for (let i = 0; i < tokens.length; ++i) {
        const elem = tokens[i];
        offset += elem.token.length;

        const cls = tokenClass(tokens, i);
        const escaped = escapeHTML(elem.token);
        html += cls ? `<span class="${cls}">${escaped}</span>` : escaped;
    }

    if (offset < text.length) {
        html += `<span class="q-err">${escapeHTML(text.substring(offset))}</span>`;
    }

    if (html.endsWith('\n')) {
        html += ' ';
    }

    query_backdrop_elem.innerHTML = html;
    query_backdrop_elem.style.display = 'block';
    query_area.classList.add('has-backdrop');
    syncQueryBackdropLayout();
}

async function updateQueryHighlighting() {
    const generation = ++query_highlight_generation;
    const text = query_area.value;

    if (!text || typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        disableQueryBackdrop();
        return;
    }

    try {
        const tokens = await tokenize(text);
        if (generation !== query_highlight_generation) {
            return;
        }

        renderQueryBackdrop(text, tokens);
    } catch (e) {
        if (generation !== query_highlight_generation) {
            return;
        }

        console.error('Tokenization failed, disabling syntax highlighting:', e);
        disableQueryBackdrop();
    }
}

function scheduleQueryHighlighting(defer = false) {
    if (query_highlight_timeout) {
        clearTimeout(query_highlight_timeout);
        query_highlight_timeout = null;
    }

    if (!defer) {
        void updateQueryHighlighting();
        return;
    }

    ++query_highlight_generation;
    disableQueryBackdrop();
    query_highlight_timeout = setTimeout(() => {
        query_highlight_timeout = null;
        void updateQueryHighlighting();
    }, large_editor_highlight_delay_ms);
}

query_area.addEventListener('input', e => {
    if (!suppress_programmatic_query_input) {
        const inserted_text_length = typeof e.data == 'string' ? e.data.length : 0;
        scheduleQueryHighlighting(inserted_text_length > large_editor_insert_threshold);
    }
    refreshAutocompleteFromEditor();
});

query_area.addEventListener('scroll', () => {
    syncQueryBackdropScroll();
    positionAutocompleteMenu();
});
