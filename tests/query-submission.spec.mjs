import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const repo_root = path.resolve(import.meta.dirname, '..');
const app_file_url = pathToFileURL(path.join(repo_root, 'click-play-boom.html')).href;

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function isProbeQuery(query) {
  const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized.includes('select version() as v')
    || normalized.includes('from system.databases')
    || normalized.includes('from system.tables')
    || normalized.includes('from system.columns')
    || normalized.includes('from system.query_log');
}

function jsonResponse(response, value) {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-ClickHouse-Format,X-ClickHouse-Query-Id',
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(value));
}

function queryResponse(response) {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-ClickHouse-Format,X-ClickHouse-Query-Id',
    'Content-Type': 'application/x-ndjson',
    'X-ClickHouse-Format': 'JSONStringsEachRowWithProgress',
    'X-ClickHouse-Query-Id': 'fake-query-id',
  });
  response.end([
    JSON.stringify({ meta: [{ name: 'ok', type: 'UInt8' }] }),
    JSON.stringify({ row: { ok: '1' } }),
    JSON.stringify({ progress: { read_rows: '1', read_bytes: '1', total_rows_to_read: '1' } }),
    '',
  ].join('\n'));
}

function compactResponse(response, names, types, rows) {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/x-ndjson',
  });
  response.end([
    JSON.stringify(names),
    JSON.stringify(types),
    ...rows.map(row => JSON.stringify(row)),
    '',
  ].join('\n'));
}

async function startFakeClickHouse(options = {}) {
  const schemaTargetMode = options.schemaTargetMode || 'native';
  const schemaCompatInsertMode = options.schemaCompatInsertMode || 'native';
  const keeperDatabaseMode = options.keeperDatabaseMode || 'match';
  const schemaMvHasGroupBy = options.schemaMvHasGroupBy !== false;
  const schemaFormatFailureMatch = options.schemaFormatFailureMatch || '';
  const submissions = [];
  const editorRequests = [];
  const sessionRequests = [];
  const catalogRequests = [];
  const statelessSettingsTestRequests = [];
  const allRequests = [];
  const dashboardRequests = [];
  const dashboardChartRequests = [];
  const schemaRequests = [];
  const schemaFormatRequests = [];
  const schemaCompatInsertRequests = [];
  const keeperDatabaseRequests = [];
  const waiters = [];
  const knownSessions = new Set();
  let expireNextEditorSession = false;
  let lockNextEditorSession = false;
  let rejectNextSettingsTest = false;
  const settingsCatalogRows = [
    { name: 'max_threads', value: '8', default: '8', description: 'Maximum query threads', type: 'MaxThreads', min: '1', max: '64', disallowed_values: [], readonly: 0, alias_for: '', is_obsolete: 0, tier: 'Production' },
    { name: 'max_result_rows', value: '0', default: '0', description: 'Maximum result rows', type: 'UInt64', min: '0', max: null, disallowed_values: [], readonly: 0, alias_for: '', is_obsolete: 0, tier: 'Production' },
    { name: 'format_csv_delimiter', value: ',', default: ',', description: 'The character used as a delimiter by CSV imports and exports; this intentionally long description verifies that complete catalog metadata remains available on hover.', type: 'Char', min: null, max: null, disallowed_values: [], readonly: 0, alias_for: '', is_obsolete: 0, tier: 'Production' },
    { name: 'readonly_example', value: '1', default: '1', description: 'Readonly example', type: 'UInt64', min: '0', max: '1', disallowed_values: [], readonly: 1, alias_for: '', is_obsolete: 0, tier: 'Production' },
    ...Array.from({ length: 14 }, (_, index) => ({
      name: `format_test_setting_${String(index + 1).padStart(2, '0')}`,
      value: '0',
      default: '0',
      description: `Synthetic format catalog setting ${index + 1}`,
      type: 'Bool',
      min: null,
      max: null,
      disallowed_values: [],
      readonly: 0,
      alias_for: '',
      is_obsolete: 0,
      tier: 'Production',
    })),
  ];

  const schemaMvCreateQuery = schemaMvHasGroupBy
    ? 'CREATE MATERIALIZED VIEW default.events_mv TO default.events_summary AS SELECT id, count() AS c FROM (SELECT id FROM default.events GROUP BY id, name) GROUP BY id'
    : 'CREATE MATERIALIZED VIEW default.events_mv TO default.events_summary AS SELECT id, count() AS c FROM (SELECT id FROM default.events GROUP BY id, name)';
  const formattedSchemaMvCreateQuery = schemaMvHasGroupBy
    ? [
        'CREATE MATERIALIZED VIEW default.events_mv TO default.events_summary',
        'AS SELECT',
        '    id,',
        '    count() AS c',
        'FROM',
        '(',
        '    SELECT id',
        '    FROM default.events',
        '    GROUP BY',
        '        id,',
        '        name',
        ')',
        'GROUP BY id',
      ].join('\n')
    : [
        'CREATE MATERIALIZED VIEW default.events_mv TO default.events_summary',
        'AS SELECT',
        '    id,',
        '    count() AS c',
        'FROM',
        '(',
        '    SELECT id',
        '    FROM default.events',
        '    GROUP BY id',
        ')',
      ].join('\n');

  function notifyWaiters() {
    for (const waiter of [...waiters]) {
      if (submissions.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(submissions.slice());
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }

    const body = await readRequestBody(request);
    const requestUrl = new URL(request.url, 'http://fake-clickhouse.test');
    const params = Object.fromEntries(requestUrl.searchParams.entries());
    allRequests.push({ body, params });

    if (body.includes('FROM system.settings')) {
      catalogRequests.push({ body, params });
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': 'X-ClickHouse-Exception-Code,X-ClickHouse-Format,X-ClickHouse-Query-Id',
        'Content-Type': 'application/x-ndjson',
      });
      response.end(`${settingsCatalogRows.map(row => JSON.stringify(row)).join('\n')}\n`);
      return;
    }

    const sessionId = requestUrl.searchParams.get('session_id') || '';
    const checksSession = requestUrl.searchParams.get('session_check') === '1';
    if (sessionId) {
      if (!checksSession) {
        knownSessions.add(sessionId);
        sessionRequests.push({ body, params, kind: 'bootstrap' });
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('');
        return;
      }

      if (lockNextEditorSession && !/^\s*SET\b/i.test(body)) {
        lockNextEditorSession = false;
        response.writeHead(500, {
          'Content-Type': 'text/plain',
          'X-ClickHouse-Exception-Code': '373',
          'Access-Control-Expose-Headers': 'X-ClickHouse-Exception-Code',
        });
        response.end('Code: 373. DB::Exception: Session is locked. (SESSION_IS_LOCKED)');
        return;
      }

      if ((expireNextEditorSession && !/^\s*SET\b/i.test(body)) || !knownSessions.has(sessionId)) {
        expireNextEditorSession = false;
        knownSessions.delete(sessionId);
        response.writeHead(500, {
          'Content-Type': 'text/plain',
          'X-ClickHouse-Exception-Code': '372',
          'Access-Control-Expose-Headers': 'X-ClickHouse-Exception-Code',
        });
        response.end('Code: 372. DB::Exception: Session not found. (SESSION_NOT_FOUND)');
        return;
      }

      if (/^\s*SET\b/i.test(body)) {
        sessionRequests.push({ body, params, kind: 'apply' });
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('');
        return;
      }

      editorRequests.push({ body, params });
    } else if (/^\s*SELECT\s+1\s*$/i.test(body)) {
      statelessSettingsTestRequests.push({ body, params });
      if (rejectNextSettingsTest) {
        rejectNextSettingsTest = false;
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        response.end('Code: 115. DB::Exception: Invalid setting value.');
        return;
      }
      queryResponse(response);
      return;
    }

    if (body.includes('SELECT version() AS v')) {
      jsonResponse(response, { v: 'test', t: 123 });
      return;
    }

    if (body.includes('formatQuery({create_query:String})')) {
      const createQuery = requestUrl.searchParams.get('param_create_query') || '';
      schemaFormatRequests.push(createQuery);
      if (schemaFormatFailureMatch && createQuery.includes(schemaFormatFailureMatch)) {
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        response.end('Formatting unavailable');
        return;
      }
      compactResponse(
        response,
        ['formatted_create_query'],
        ['String'],
        [[createQuery.includes('default.events_mv')
          ? formattedSchemaMvCreateQuery
          : createQuery.replace(' ENGINE = ', '\nENGINE = ').replace(' ORDER BY ', '\nORDER BY ')]],
      );
      return;
    }

    if (body.includes('FROM system.databases')) {
      jsonResponse(response, { data: [
        { database: 'default', current: 1 },
        { database: 'analytics', current: 0 },
        { database: 'sales_100%', current: 0 },
        { database: 'system', current: 0 },
      ] });
      return;
    }

    if (body.includes('FROM system.zookeeper')
      && body.includes('allow_unrestricted_reads_from_keeper')) {
      keeperDatabaseRequests.push({
        body,
        params: Object.fromEntries(requestUrl.searchParams.entries()),
      });
      if (keeperDatabaseMode === 'error') {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('Not enough privileges to read system.zookeeper');
        return;
      }
      jsonResponse(response, {
        data: keeperDatabaseMode === 'match' ? [{ found: 1 }] : [],
      });
      return;
    }

    if (body.includes('FROM system.columns')
      && body.includes("table = 'tables'")
      && body.includes("'target_database'")) {
      compactResponse(response, ['name'], ['String'], schemaTargetMode === 'native'
        ? [['target_database'], ['target_table']]
        : []);
      return;
    }

    if (body.includes('FROM system.columns')
      && body.includes("table = 'schema_mv_targets'")) {
      compactResponse(response, ['name'], ['String'], schemaTargetMode === 'compat'
        ? [['database'], ['name'], ['target_database'], ['target_table'], ['updated_at']]
        : []);
      return;
    }

    if (body.includes('FROM system.tables')
      && body.includes("target_database != ''")
      && body.includes("target_table != ''")) {
      schemaCompatInsertRequests.push({
        body,
        user: requestUrl.searchParams.get('user') || '',
        password: requestUrl.searchParams.get('password') || '',
      });
      if (schemaCompatInsertMode === 'unsupported') {
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        response.end('Code: 47. Unknown expression identifier target_database');
        return;
      }
      jsonResponse(response, {
        data: schemaCompatInsertMode === 'empty' ? [] : [
          {
            database: 'default',
            name: 'events_mv',
            target_database: 'default',
            target_table: 'events_summary',
          },
          {
            database: "sales'o",
            name: 'mv\\daily\nload',
            target_database: 'warehouse',
            target_table: "target'name",
          },
        ],
      });
      return;
    }

    if (body.includes('SELECT table, engine, total_rows, total_bytes FROM system.tables')) {
      jsonResponse(response, {
        data: requestUrl.searchParams.get('param_database') === 'default'
          ? [{ table: 'events', engine: 'MergeTree', total_rows: 2, total_bytes: 128 }]
          : [],
      });
      return;
    }

    if (body.includes('SELECT name, type')
      && body.includes('FROM system.columns')
      && body.includes('table = {table:String}')) {
      jsonResponse(response, {
        data: requestUrl.searchParams.get('param_database') === 'default'
          && requestUrl.searchParams.get('param_table') === 'events'
          ? [{ name: 'id', type: 'UInt64' }, { name: 'name', type: 'String' }]
          : [],
      });
      return;
    }

    if (body.includes('FROM system.dashboards')) {
      dashboardRequests.push({
        body,
        params,
        user: requestUrl.searchParams.get('user') || '',
        password: requestUrl.searchParams.get('password') || '',
      });

      if (body.includes('SELECT dashboard FROM system.dashboards')) {
        jsonResponse(response, {
          meta: [{ name: 'dashboard', type: 'String' }],
          data: { dashboard: ['Overview'] },
          rows: 1,
        });
      } else {
        jsonResponse(response, {
          meta: [
            { name: 'title', type: 'String' },
            { name: 'query', type: 'String' },
          ],
          data: {
            title: ['Tiny dashboard'],
            query: ['SELECT {seconds:UInt32} AS t, toUInt32(2) AS v, {rounding:UInt32} AS r'],
          },
          rows: 1,
        });
      }
      return;
    }

    if (body.includes('SELECT {seconds:UInt32} AS t, toUInt32(2) AS v')) {
      dashboardChartRequests.push({
        body,
        params: Object.fromEntries(requestUrl.searchParams.entries()),
      });
      jsonResponse(response, {
        meta: [
          { name: 't', type: 'UInt32' },
          { name: 'v', type: 'UInt32' },
        ],
        data: {
          t: [1],
          v: [2],
        },
        rows: 1,
      });
      return;
    }

    if (body.includes('FROM system.tables') && body.includes('engine_full')) {
      schemaRequests.push({
        body,
        user: requestUrl.searchParams.get('user') || '',
        password: requestUrl.searchParams.get('password') || '',
      });
      compactResponse(response, [
        'database',
        'name',
        'engine',
        'engine_full',
        'create_table_query',
        'sorting_key',
        'primary_key',
        'partition_key',
        'sampling_key',
        'total_rows',
        'total_bytes',
        'comment',
        'target_database',
        'target_table',
        'dependents',
        'depends_on',
      ], [
        'String',
        'String',
        'String',
        'String',
        'String',
        'String',
        'String',
        'String',
        'String',
        'UInt64',
        'UInt64',
        'String',
        'String',
        'String',
        'Array(String)',
        'Array(String)',
      ], [
        ['analytics', 'raw_events', 'MergeTree', 'MergeTree ORDER BY id', 'CREATE TABLE analytics.raw_events (id UInt64) ENGINE = MergeTree ORDER BY id', 'id', 'id', '', '', 5, 256, '', '', '', [], []],
        ['default', 'events', 'MergeTree', 'MergeTree ORDER BY id', 'CREATE TABLE default.events (id UInt64, name String) ENGINE = MergeTree ORDER BY id', 'id', 'id', '', '', 2, 128, '', '', '', ['default.events_mv'], []],
        ['default', 'events_mv', 'MaterializedView', 'MaterializedView', schemaMvCreateQuery, '', '', '', '', 0, 0, '', schemaTargetMode === 'missing' ? '' : 'default', schemaTargetMode === 'missing' ? '' : 'events_summary', schemaTargetMode === 'native' ? ['default.events_summary'] : [], ['default.events']],
        ['default', 'events_summary', 'ReplicatedAggregatingMergeTree', 'ReplicatedAggregatingMergeTree ORDER BY tuple()', 'CREATE TABLE default.events_summary (c UInt64) ENGINE = ReplicatedAggregatingMergeTree ORDER BY tuple()', '', '', '', '', 1, 64, '', '', '', [], []],
      ]);
      return;
    }

    if (body.includes('FROM system.columns') && body.includes('is_in_primary_key')) {
      compactResponse(response, [
        'database',
        'table',
        'name',
        'type',
        'is_key',
        'has_default',
      ], [
        'String',
        'String',
        'String',
        'String',
        'UInt8',
        'UInt8',
      ], [
        ['analytics', 'raw_events', 'id', 'UInt64', 1, 0],
        ['default', 'events', 'id', 'UInt64', 1, 0],
        ['default', 'events', 'name', 'String', 0, 0],
        ['default', 'events_mv', 'c', 'UInt64', 0, 0],
        ['default', 'events_summary', 'c', 'UInt64', 0, 0],
      ]);
      return;
    }

    if (body.includes('FROM system.dictionaries')) {
      compactResponse(response, ['database', 'name', 'source'], ['String', 'String', 'String'], []);
      return;
    }

    if (body.includes('FROM system.view_refreshes')) {
      compactResponse(response, ['database', 'view', 'status', 'last_success_time', 'next_refresh_time', 'exception'], ['String', 'String', 'String', 'String', 'String', 'String'], []);
      return;
    }

    if (body.includes('FROM system.query_views_log')) {
      compactResponse(response, [
        'view_name',
        'view_target',
        'executions',
        'total_duration_ms',
        'read_rows',
        'read_bytes',
        'written_rows',
        'written_bytes',
        'peak_memory_usage',
      ], [
        'String',
        'String',
        'UInt64',
        'UInt64',
        'UInt64',
        'UInt64',
        'UInt64',
        'UInt64',
        'UInt64',
      ], [
        ['default.events_mv', 'default.events_summary', 3, 42, 20, 200, 2, 64, 1024],
      ]);
      return;
    }

    if (isProbeQuery(body)) {
      jsonResponse(response, { data: [] });
      return;
    }

    submissions.push(body);
    notifyWaiters();
    queryResponse(response);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/`,
    submissions,
    editorRequests,
    sessionRequests,
    catalogRequests,
    statelessSettingsTestRequests,
    allRequests,
    dashboardRequests,
    dashboardChartRequests,
    schemaRequests,
    schemaFormatRequests,
    schemaCompatInsertRequests,
    keeperDatabaseRequests,
    expireNextSession() {
      expireNextEditorSession = true;
    },
    lockNextSession() {
      lockNextEditorSession = true;
    },
    rejectNextSettingsTest() {
      rejectNextSettingsTest = true;
    },
    waitForSubmissions(count) {
      if (submissions.length >= count) {
        return Promise.resolve(submissions.slice());
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for ${count} query submission(s); saw ${submissions.length}.`));
        }, 3000);
        const waiter = { count, resolve, timeout };
        waiters.push(waiter);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

async function openApp(page, serverUrl) {
  await page.goto(`${app_file_url}?url=${encodeURIComponent(serverUrl)}&user=default`);
  await expect(page.locator('#query')).toBeVisible();
  await expect(page.locator('#run')).toHaveText('Run all');
}

async function openAppWithPassword(page, serverUrl, password) {
  await page.goto(`${app_file_url}?url=${encodeURIComponent(serverUrl)}&user=default&password=${encodeURIComponent(password)}`);
  await expect(page.locator('#query')).toBeVisible();
  await expect(page.locator('#run')).toHaveText('Run all');
}

async function openSettings(page) {
  await page.locator('#app-view-settings').click();
  await expect(page.locator('#settings_workspace')).toBeVisible();
  await expect(page.locator('#settings-catalog-status')).toContainText('settings loaded');
}

async function addSettingsEditorRow(page, rowsSelector, name, value) {
  const row = page.locator(`${rowsSelector} .settings-editor-row`)
    .filter({ has: page.locator('input:not(:disabled)') })
    .last();
  await row.locator('input').nth(0).fill(name);
  await row.locator('input').nth(1).fill(value);
  return row;
}

async function stubUplot(page) {
  await page.evaluate(() => {
    window.uPlot = function(opts, data, element) {
      this.opts = opts;
      this.data = data;
      this.over = document.createElement('div');
      this.over.className = 'u-over';
      element.appendChild(this.over);
      this.destroy = function() {};
      this.setSize = function() {};
      this.setScale = function() {};
    };
    window.uPlot.sync = function() { return { sub: function() {} }; };
    window.uPlot.assign = Object.assign;
    window.loadUplot = function() { return Promise.resolve(true); };
  });
}

async function expectVisibleRectsDoNotOverlap(page, selector) {
  const overlaps = await page.locator(selector).evaluateAll(elements => {
    const rects = elements
      .map(element => {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return null;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return null;
        }
        return {
          name: element.id || element.className || element.tagName,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      })
      .filter(Boolean);

    const result = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const horizontal = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
        const vertical = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
        if (horizontal > 1 && vertical > 1) {
          result.push(`${rects[i].name} overlaps ${rects[j].name}`);
        }
      }
    }
    return result;
  });
  expect(overlaps).toEqual([]);
}

async function setEditorText(page, text) {
  const editor = page.locator('#query');
  await editor.fill(text);
  await expect(editor).toHaveValue(text);
}

async function selectEditorText(page, fullText, selectedText) {
  const start = fullText.indexOf(selectedText);
  expect(start, `selected text should exist in editor text: ${selectedText}`).toBeGreaterThanOrEqual(0);
  const end = start + selectedText.length;
  const editor = page.locator('#query');

  await editor.evaluate((textarea, selection) => {
    textarea.focus();
    textarea.setSelectionRange(selection.start, selection.end);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, { start, end });

  await expect(page.locator('#run')).toHaveText('Run selected');
}

async function setEditorSelection(page, start, end = start) {
  const editor = page.locator('#query');
  await editor.evaluate((textarea, selection) => {
    textarea.focus();
    textarea.setSelectionRange(selection.start, selection.end);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
  }, { start, end });
}

test.describe('query submission safety', () => {
  let fakeClickHouse;

  test.beforeEach(async ({ page }) => {
    fakeClickHouse = await startFakeClickHouse();
    await openApp(page, fakeClickHouse.url);
  });

  test.afterEach(async () => {
    await fakeClickHouse?.close();
  });

  test('Tab inserts four spaces after focus has traversed another input', async ({ page }) => {
    const editor = page.locator('#query');
    await setEditorText(page, 'SELECT');

    await page.locator('#schema-filter').focus();
    await page.keyboard.press('Tab');
    await setEditorSelection(page, 6);
    await page.keyboard.press('Tab');

    await expect(editor).toHaveValue('SELECT    ');
    await expect.poll(() => editor.evaluate(textarea => textarea.selectionStart)).toBe(10);
  });

  test('Tab indents selected lines without including a trailing boundary line', async ({ page }) => {
    const editor = page.locator('#query');
    const script = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    const selectionEnd = script.indexOf('SELECT 3;');
    await setEditorText(page, script);
    await setEditorSelection(page, 0, selectionEnd);

    await page.keyboard.press('Tab');

    await expect(editor).toHaveValue('    SELECT 1;\n    SELECT 2;\nSELECT 3;');
    await expect.poll(() => editor.evaluate(textarea => ({
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    }))).toEqual({ start: 0, end: selectionEnd + 8 });
  });

  test('Shift+Tab outdents the caret line and mixed selected indentation', async ({ page }) => {
    const editor = page.locator('#query');
    await setEditorText(page, '    SELECT 1;');
    await setEditorSelection(page, 13);

    await page.keyboard.press('Shift+Tab');

    await expect(editor).toHaveValue('SELECT 1;');
    await expect.poll(() => editor.evaluate(textarea => textarea.selectionStart)).toBe(9);

    const mixedIndentation = '    SELECT 1;\n  SELECT 2;\n\tSELECT 3;';
    await setEditorText(page, mixedIndentation);
    await setEditorSelection(page, 0, mixedIndentation.length);

    await page.keyboard.press('Shift+Tab');

    await expect(editor).toHaveValue('SELECT 1;\nSELECT 2;\nSELECT 3;');
  });

  test('Tab accepts autocomplete before editor indentation', async ({ page }) => {
    const editor = page.locator('#query');
    await setEditorText(page, 'ana');
    await setEditorSelection(page, 3);
    await page.evaluate(() => {
      autocomplete_state = {
        open: true,
        replace_start: 0,
        scope_key: '',
        statement_key: '',
        items: [{
          kind: 'database',
          label: 'analytics',
          insert_text: 'analytics',
          detail: 'database',
          rank: 10,
          search_text: 'analytics database',
        }],
        all_items: [],
        active_index: 0,
        prefix: 'ana',
        loading: false,
        schema_revision: autocomplete_schema_revision,
      };
      renderAutocompleteMenu();
    });
    await expect(page.locator('#autocomplete-menu')).toHaveClass(/open/);

    await page.keyboard.press('Tab');

    await expect(editor).toHaveValue('analytics');
    await expect(page.locator('#autocomplete-menu')).not.toHaveClass(/open/);
  });

  test('Escape then Tab leaves the editor without changing SQL', async ({ page }) => {
    const editor = page.locator('#query');
    await setEditorText(page, 'SELECT 1;');
    await setEditorSelection(page, 9);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');

    await expect(editor).toHaveValue('SELECT 1;');
    await expect(page.locator('#toggle-editor')).toBeFocused();
  });

  test('run all submits every statement in order', async ({ page }) => {
    await setEditorText(page, 'SELECT 1;\nSELECT 2;');

    await page.locator('#run').click();

    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  test('keyboard shortcut with selected text submits only the selection', async ({ page }) => {
    const script = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    await setEditorText(page, script);
    await selectEditorText(page, script, 'SELECT 2;');

    await page.keyboard.press('Control+Enter');

    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 2;']);
  });

  test('keyboard shortcut submits the live selection when a drag ends outside the editor', async ({ page }) => {
    const statements = Array.from({ length: 10 }, (_, index) => `SELECT ${index + 1};`);
    const script = statements.join('\n');
    const editor = page.locator('#query');
    await setEditorText(page, script);

    // Seed the previous runnable snapshot, then model a boundary drag whose final
    // native selection is not followed by another textarea-local selection event.
    await selectEditorText(page, script, statements.at(-1));
    await editor.evaluate(textarea => {
      textarea.addEventListener('select', event => event.stopImmediatePropagation(), true);
    });

    const box = await editor.boundingBox();
    expect(box).not.toBeNull();
    const metrics = await editor.evaluate(textarea => {
      const style = getComputedStyle(textarea);
      return {
        paddingLeft: parseFloat(style.paddingLeft),
        paddingTop: parseFloat(style.paddingTop),
        lineHeight: parseFloat(style.lineHeight),
      };
    });

    await page.mouse.move(
      box.x + metrics.paddingLeft + 1,
      box.y + metrics.paddingTop + metrics.lineHeight / 2,
    );
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 20, box.y + box.height + 20, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => editor.evaluate(textarea =>
      textarea.value.substring(textarea.selectionStart, textarea.selectionEnd)
    )).toBe(script);

    await page.keyboard.press('Control+Enter');

    await expect.poll(() => fakeClickHouse.submissions).toEqual(statements);
  });

  test('keyboard shortcut runs all after focus deliberately leaves the editor', async ({ page }) => {
    const script = 'SELECT 1;\nSELECT 2;';
    await setEditorText(page, script);
    await selectEditorText(page, script, 'SELECT 2;');

    await page.locator('#schema-filter').focus();
    await expect(page.locator('#run')).toHaveText('Run all');
    await page.keyboard.press('Control+Enter');

    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  test('run button preserves selected text when focus moves to the button', async ({ page }) => {
    const script = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    await setEditorText(page, script);
    await selectEditorText(page, script, 'SELECT 2;');

    await page.locator('#run').click();

    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 2;']);
  });

  test('syntax highlighting backdrop follows editor resizing across workspace switches', async ({ page }) => {
    const editor = page.locator('#query');
    const backdrop = page.locator('#query-backdrop');
    await setEditorText(page, 'SELECT number, count() FROM system.numbers GROUP BY number');
    await expect(backdrop).toBeVisible();

    const initialEditorWidth = await editor.evaluate(element => element.getBoundingClientRect().width);
    await page.locator('#app-view-schema').click();
    await expect(page.locator('#query_div')).toBeHidden();
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.locator('#app-view-query').click();

    await expect(editor).toBeVisible();
    await expect.poll(() => editor.evaluate(element => element.getBoundingClientRect().width))
      .toBeGreaterThan(initialEditorWidth);
    await expect.poll(async () => {
      const editorWidth = await editor.evaluate(element => element.getBoundingClientRect().width);
      const backdropWidth = await backdrop.evaluate(element => element.getBoundingClientRect().width);
      return Math.abs(editorWidth - backdropWidth);
    }).toBeLessThanOrEqual(1);
  });

  test('selected statement inside maintenance script is the only submitted body', async ({ page }) => {
    const script = [
      'create table blah_new',
      'as',
      'select * from blah where x > y;',
      '',
      'drop table blah;',
      '',
      'rename table blah_new to blah;',
    ].join('\n');
    await setEditorText(page, script);
    await selectEditorText(page, script, 'drop table blah;');

    await page.locator('#run').click();

    await expect.poll(() => fakeClickHouse.submissions).toEqual(['drop table blah;']);
  });

  test('dashboard workspace loads with active connection credentials', async ({ page }) => {
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');
    await stubUplot(page);

    await page.locator('#app-view-dashboard').click();

    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('dashboard');
    await expect(page.locator('#dashboard_workspace')).toBeVisible();
    await expect(page.locator('#dashboard-mass-editor')).toBeHidden();
    await expect(page.locator('.dashboard-range')).toBeVisible();
    await expect(page.getByText('Bucket')).toBeVisible();
    await expect(page.locator('.dashboard-chart-title')).toHaveText('Tiny dashboard');
    await page.setViewportSize({ width: 1100, height: 760 });
    const zoomStyle = await page.addStyleTag({ content: 'html { font-size: 150%; }' });
    await expectVisibleRectsDoNotOverlap(page, '#active-connection-banner > *');
    await expectVisibleRectsDoNotOverlap(page, '#dashboard-controls > *');
    await zoomStyle.evaluate(element => element.remove());
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByRole('button', { name: 'Ok' })).toHaveCount(0);
    await page.locator('[name="dashboard-range-unit"]').selectOption('60');
    await expect.poll(() => fakeClickHouse.dashboardChartRequests.some(request =>
      request.params.param_seconds == '60' && request.params.param_rounding == '60'
    )).toBe(true);
    await expect(page.locator('#dashboard-edit')).toBeEnabled();
    await page.locator('#dashboard-edit').click();
    await expect(page.locator('#dashboard-mass-editor')).toBeVisible();
    await expect.poll(() => page.locator('#dashboard-mass-editor-textarea').evaluate(element =>
      element.getBoundingClientRect().height
    )).toBeGreaterThan(200);
    await page.reload();
    await expect(page.locator('#dashboard_workspace')).toBeVisible();
    await expect.poll(() => fakeClickHouse.dashboardRequests.some(request =>
      request.user == 'default' && request.password == 'secret'
    )).toBe(true);
  });

  test('schema workspace loads with active connection credentials', async ({ page }) => {
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');

    await page.locator('#app-view-schema').click();

    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('schema');
    await expect(page.locator('#schema_workspace')).toBeVisible();
    await expect(page.locator('#query_div')).toBeHidden();
    await expect(page.locator('.schema-node[data-key="default.events"]')).toBeVisible();
    await expect(page.locator('.schema-node[data-key="default.events"] .schema-node-kind')).toHaveText('mt');
    await expect(page.locator('.schema-node[data-key="default.events"] .schema-node-kind')).toHaveAttribute('title', 'MergeTree');
    await expect(page.locator('.schema-node[data-key="default.events_mv"] .schema-node-kind')).toHaveText('mv');
    await expect(page.locator('.schema-node[data-key="default.events_mv"] .schema-node-kind')).toHaveAttribute('title', 'MaterializedView');
    await expect(page.locator('.schema-node[data-key="default.events_summary"] .schema-node-kind')).toHaveText('rep.amt');
    await expect(page.locator('.schema-node[data-key="default.events_summary"] .schema-node-kind')).toHaveAttribute('title', 'ReplicatedAggregatingMergeTree');
    await expect(page.locator('.schema-arrow')).toHaveCount(2);
    await expect(page.locator('#schema-status')).toContainText('Loaded 4 tables');
    await page.locator('#schema-db-filter-button').click();
    await page.getByLabel('analytics (1)').check();
    await expect(page.locator('#schema-db-filter-button')).toHaveText('analytics');
    await expect(page.locator('.schema-node[data-key="analytics.raw_events"]')).toBeVisible();
    await expect(page.locator('.schema-node[data-key="default.events"]')).toHaveCount(0);
    await page.getByLabel('All databases').check();
    await expect(page.locator('#schema-db-filter-button')).toHaveText('All databases');
    await page.locator('#schema-search').fill('summary');
    await expect(page.locator('.schema-node[data-key="default.events_summary"]')).toBeVisible();
    await expect(page.locator('.schema-node[data-key="default.events"]')).toHaveCount(0);
    await page.locator('#schema-search').fill('');
    await expect(page.locator('.schema-node[data-key="default.events"]')).toBeVisible();
    await page.locator('.schema-node[data-key="default.events"]').click();
    await expect(page.locator('#schema-sidebar')).toHaveClass(/open/);
    await expect(page.locator('#schema-sidebar-title')).toContainText('default.events');
    await expect(page.locator('.schema-create-statement')).toContainText('\nENGINE = MergeTree\nORDER BY id');
    await page.locator('.schema-node[data-key="default.events_mv"]').click();
    await expect(page.locator('.schema-group-by')).toHaveText('id');
    await expect(page.locator('.schema-create-statement')).toContainText('\n    GROUP BY\n        id,\n        name\n)\nGROUP BY id');
    await page.locator('.schema-node[data-key="default.events"]').click();
    await page.locator('.schema-node[data-key="default.events_mv"]').click();
    await expect.poll(() => fakeClickHouse.schemaFormatRequests.filter(query =>
      query.includes('default.events_mv')
    ).length).toBe(1);
    await page.reload();
    await expect(page.locator('#schema_workspace')).toBeVisible();
    await expect(page.locator('.schema-node').filter({ hasText: 'events_summary' }).first()).toBeVisible();
    await expect.poll(() => fakeClickHouse.schemaRequests.some(request =>
      request.user == 'default' && request.password == 'secret'
    )).toBe(true);
  });

  test('schema CREATE formatting handles ungrouped MVs and formatter failures', async ({ page }) => {
    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({
      schemaMvHasGroupBy: false,
      schemaFormatFailureMatch: 'analytics.raw_events',
    });
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');
    await page.locator('#app-view-schema').click();

    await page.locator('.schema-node[data-key="default.events_mv"]').click();
    await expect(page.locator('.schema-group-by')).toHaveText('None');
    await expect(page.locator('.schema-create-statement')).toContainText('    GROUP BY id\n)');

    await page.locator('.schema-node[data-key="analytics.raw_events"]').click();
    await expect(page.locator('.schema-create-statement')).toHaveText(
      'CREATE TABLE analytics.raw_events (id UInt64) ENGINE = MergeTree ORDER BY id',
    );
    await page.locator('.schema-node[data-key="default.events_mv"]').click();
    await page.locator('.schema-node[data-key="analytics.raw_events"]').click();
    await expect.poll(() => fakeClickHouse.schemaFormatRequests.filter(query =>
      query.includes('analytics.raw_events')
    ).length).toBe(1);
  });

  test('schema workspace uses optional MV target compatibility table on older servers', async ({ page }) => {
    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ schemaTargetMode: 'compat' });
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');

    await page.locator('.navigator-connection-menu').click();
    await page.getByRole('button', { name: 'Generate schema compat table' }).click();
    await expect(page.locator('#schema-compat-editor')).toHaveClass(/open/);
    await page.locator('#schema-compat-database').selectOption('analytics');
    await page.locator('#schema-compat-editor-generate').click();

    await expect(page.locator('#query')).toHaveValue(/CREATE TABLE IF NOT EXISTS analytics\.schema_mv_targets/);
    await expect(page.locator('#query')).not.toHaveValue(/CREATE DATABASE/);
    await expect.poll(() => page.evaluate(() =>
      getSavedConnections().find(connection => connection.id == current_connection_id)?.schema_compat_database
    )).toBe('analytics');

    await page.locator('.navigator-connection-menu').click();
    await page.getByRole('button', { name: 'Edit connection' }).click();
    await page.locator('#connection-editor-save').click();
    await expect.poll(() => page.evaluate(() =>
      getSavedConnections().find(connection => connection.id == current_connection_id)?.schema_compat_database
    )).toBe('analytics');

    await page.locator('#app-view-schema').click();

    await expect(page.locator('#schema_workspace')).toBeVisible();
    await expect(page.locator('#schema-status')).toContainText('MV targets: analytics.schema_mv_targets');
    await expect(page.locator('.schema-arrow')).toHaveCount(2);
    await expect.poll(() => fakeClickHouse.schemaRequests.some(request =>
      request.body.includes('LEFT JOIN') && request.body.includes('analytics.schema_mv_targets')
    )).toBe(true);
  });

  test('source connection generates reviewable schema compatibility inserts', async ({ page }) => {
    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse();
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');
    await page.evaluate(() => {
      const connections = getSavedConnections();
      const production = {
        ...createConnection('Production'),
        id: 'production-connection',
        name: 'Production',
        url: connections[0].url,
        user: 'production_user',
        password: 'production_secret',
      };
      saveConnections([...connections, production]);
      renderNavigatorTree();
    });

    const sourceMenu = page.locator('.navigator-connection.current .navigator-connection-menu');
    await sourceMenu.click();
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('prompt');
      expect(dialog.message()).toBe('Compatibility table database');
      expect(dialog.defaultValue()).toBe('system');
      await dialog.accept('ops_metadata');
    });
    await page.getByRole('button', { name: 'Generate schema compat inserts' }).click();

    const expectedSql = [
      'INSERT INTO ops_metadata.schema_mv_targets',
      '    (database, name, target_database, target_table)',
      'VALUES',
      "    ('default', 'events_mv', 'default', 'events_summary'),",
      "    ('sales\\'o', 'mv\\\\daily\\nload', 'warehouse', 'target\\'name');",
    ].join('\n');
    await expect(page.locator('#query')).toHaveValue(expectedSql);
    await expect(page.locator('#run')).toHaveText('Run selected');
    await expect(page.locator('#query_div')).toBeVisible();
    await expect.poll(() => fakeClickHouse.schemaCompatInsertRequests.length).toBe(1);
    expect(fakeClickHouse.schemaCompatInsertRequests[0]).toMatchObject({
      user: 'default',
      password: 'secret',
    });
    expect(fakeClickHouse.schemaCompatInsertRequests[0].body).toContain(
      "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')",
    );
    expect(fakeClickHouse.submissions).toEqual([]);

    await sourceMenu.click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Generate schema compat inserts' }).click();
    await expect.poll(() => fakeClickHouse.schemaCompatInsertRequests.length).toBe(1);
    await expect(page.locator('#query')).toHaveValue(expectedSql);

    await page.locator('.navigator-connection-button').filter({ hasText: 'Production' }).click();
    await expect(page.locator('#query')).toHaveValue(expectedSql);
    await expect(page.locator('.navigator-connection.current')).toContainText('Production');
  });

  test('schema compatibility insert generation reports empty and unsupported sources', async ({ page }) => {
    const originalSql = 'SELECT untouched';

    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ schemaCompatInsertMode: 'empty' });
    await page.evaluate(() => window.localStorage.clear());
    await openApp(page, fakeClickHouse.url);
    await setEditorText(page, originalSql);
    let alertMessage = '';
    const emptyDialogHandler = async dialog => {
      if (dialog.type() === 'prompt') {
        await dialog.accept('system');
      } else {
        alertMessage = dialog.message();
        await dialog.accept();
      }
    };
    page.on('dialog', emptyDialogHandler);
    await page.locator('.navigator-connection-menu').click();
    await page.getByRole('button', { name: 'Generate schema compat inserts' }).click();
    await expect.poll(() => alertMessage).toContain('No native materialized-view target mappings');
    await expect(page.locator('#query')).toHaveValue(originalSql);
    page.off('dialog', emptyDialogHandler);

    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ schemaCompatInsertMode: 'unsupported' });
    await page.evaluate(() => window.localStorage.clear());
    await openApp(page, fakeClickHouse.url);
    await setEditorText(page, originalSql);
    alertMessage = '';
    const unsupportedDialogHandler = async dialog => {
      if (dialog.type() === 'prompt') {
        await dialog.accept('system');
      } else {
        alertMessage = dialog.message();
        await dialog.accept();
      }
    };
    page.on('dialog', unsupportedDialogHandler);
    await page.locator('.navigator-connection-menu').click();
    await page.getByRole('button', { name: 'Generate schema compat inserts' }).click();
    await expect.poll(() => alertMessage).toContain('Could not generate schema compatibility inserts');
    await expect(page.locator('#query')).toHaveValue(originalSql);
    page.off('dialog', unsupportedDialogHandler);
  });

  test('database menu generates a Keeper-aware clustered drop', async ({ page }) => {
    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ keeperDatabaseMode: 'match' });
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');

    await expect(page.locator('.navigator-connection.current .navigator-connection-action')).toHaveText(['+', '−']);
    await expect(page.getByTitle('Expand all tables and views in this database')).toHaveCount(0);
    await expect(page.getByTitle('Collapse all tables and views in this database')).toHaveCount(0);

    const databaseHeader = page.locator('.database-header').filter({ hasText: 'sales_100%' });
    await expect(databaseHeader.locator('.navigator-header-action')).toHaveText('⋯');
    await databaseHeader.locator('.navigator-header-action').click();
    await expect(page.getByRole('button', { name: 'Insert database name' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate DROP DATABASE' })).toBeVisible();
    await page.getByRole('button', { name: 'Generate DROP DATABASE' }).click();

    await expect(page.locator('#query')).toHaveValue(
      "DROP DATABASE `sales_100%` ON CLUSTER '{cluster}' SYNC;",
    );
    await expect(page.locator('#run')).toHaveText('Run selected');
    await expect.poll(() => fakeClickHouse.keeperDatabaseRequests.length).toBe(1);
    expect(fakeClickHouse.keeperDatabaseRequests[0].params).toMatchObject({
      user: 'default',
      password: 'secret',
      param_path_pattern: '%sales\\_100\\%%',
    });
    expect(fakeClickHouse.keeperDatabaseRequests[0].body).toContain('SELECT 1 AS found');
    expect(fakeClickHouse.keeperDatabaseRequests[0].body).toContain('LIMIT 1');
    expect(fakeClickHouse.keeperDatabaseRequests[0].body).toContain(
      'SETTINGS allow_unrestricted_reads_from_keeper = true',
    );
    expect(fakeClickHouse.submissions).toEqual([]);

    await databaseHeader.click({ button: 'right' });
    await expect(page.getByRole('button', { name: 'Insert database name' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate DROP DATABASE' })).toBeVisible();
  });

  test('database drop generation handles no Keeper match and fails closed on errors', async ({ page }) => {
    const originalSql = 'SELECT untouched';

    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ keeperDatabaseMode: 'empty' });
    await page.evaluate(() => window.localStorage.clear());
    await openApp(page, fakeClickHouse.url);
    await page.locator('.database-header').filter({ hasText: 'default' })
      .locator('.navigator-header-action').click();
    await page.getByRole('button', { name: 'Generate DROP DATABASE' }).click();
    await expect(page.locator('#query')).toHaveValue('DROP DATABASE default SYNC;');
    await expect(page.locator('#run')).toHaveText('Run selected');
    expect(fakeClickHouse.submissions).toEqual([]);

    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ keeperDatabaseMode: 'error' });
    await page.evaluate(() => window.localStorage.clear());
    await openApp(page, fakeClickHouse.url);
    await setEditorText(page, originalSql);
    let alertMessage = '';
    page.once('dialog', async dialog => {
      alertMessage = dialog.message();
      await dialog.accept();
    });
    await page.locator('.database-header').filter({ hasText: 'default' })
      .locator('.navigator-header-action').click();
    await page.getByRole('button', { name: 'Generate DROP DATABASE' }).click();
    await expect.poll(() => alertMessage).toContain('No DROP DATABASE statement was generated');
    await expect(page.locator('#query')).toHaveValue(originalSql);
    await expect.poll(() => fakeClickHouse.keeperDatabaseRequests.length).toBe(1);
  });

  test('server menu generates a compatibility table in a new database', async ({ page }) => {
    await page.locator('.navigator-connection-menu').click();
    await page.getByRole('button', { name: 'Generate schema compat table' }).click();
    await page.locator('#schema-compat-create-database').check();
    await page.locator('#schema-compat-new-database').fill('ops_metadata');
    await page.locator('#schema-compat-editor-generate').click();

    await expect(page.locator('#query')).toHaveValue(/CREATE DATABASE IF NOT EXISTS ops_metadata/);
    await expect(page.locator('#query')).toHaveValue(/CREATE TABLE IF NOT EXISTS ops_metadata\.schema_mv_targets/);
    await expect.poll(() => page.evaluate(() =>
      getSavedConnections().find(connection => connection.id == current_connection_id)?.schema_compat_database
    )).toBe('ops_metadata');

    await page.locator('.database-header').first().click({ button: 'right' });
    await expect(page.locator('#navigator-context-menu')).not.toContainText('Generate schema compat table');
  });

  test('settings is a routable workspace and preferences remain synchronized', async ({ page }) => {
    await openSettings(page);

    await expect(page).toHaveURL(/(?:\?|&)view=settings(?:&|$)/);
    await expect(page.locator('dialog')).toHaveCount(0);
    await page.locator('#settings-abort-preview').check();
    await expect(page.locator('#abort-preview-limit')).toBeChecked();
    await page.locator('#settings-compact-editor').check();
    await expect(page.locator('#query_div')).toHaveClass(/compact/);
    await page.locator('#settings-snippet-mode').selectOption('overwrite');
    await expect(page.locator('#snippet-insertion-mode')).toHaveValue('overwrite');

    await page.reload();
    await expect(page.locator('#settings_workspace')).toBeVisible();
    await expect(page.locator('#settings-abort-preview')).toBeChecked();
    await expect(page.locator('#settings-compact-editor')).toBeChecked();
    await expect(page.locator('#settings-snippet-mode')).toHaveValue('overwrite');
  });

  test('preference storage events synchronize another open app tab', async ({ page, context }) => {
    const otherPage = await context.newPage();
    await openApp(otherPage, fakeClickHouse.url);
    await openSettings(otherPage);
    await openSettings(page);

    await page.locator('#settings-query-cache').check();
    await expect(otherPage.locator('#settings-query-cache')).toBeChecked();
    await expect(otherPage.locator('#download-use-cache')).toBeChecked();

    await otherPage.close();
  });

  test('failed effective-settings tests preserve the connection draft and stay stateless', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-query-default-add').click();
    const row = await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '3');
    fakeClickHouse.rejectNextSettingsTest();
    await page.locator('#settings-query-default-test').click();

    await expect(page.locator('#settings-query-default-message')).toContainText('Invalid setting value');
    await expect(row.locator('input').nth(1)).toHaveValue('3');
    expect(fakeClickHouse.statelessSettingsTestRequests).toHaveLength(1);
    expect(fakeClickHouse.statelessSettingsTestRequests[0].params).toMatchObject({ max_threads: '3' });
    expect(fakeClickHouse.statelessSettingsTestRequests[0].params.session_id).toBeUndefined();
    expect(await page.evaluate(() => window.localStorage.getItem(query_defaults_key))).toBeNull();
  });

  test('catalog metadata blocks readonly settings and duplicate rows before save', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-query-default-add').click();
    const readonlyRow = await addSettingsEditorRow(page, '#settings-query-default-rows', 'readonly_example', '1');
    await expect(readonlyRow.locator('.settings-setting-warning')).toContainText('readonly');
    await page.locator('#settings-query-default-save').click();
    await expect(page.locator('#settings-query-default-message')).toContainText('readonly');
    await readonlyRow.getByRole('button', { name: 'Remove' }).click();

    await page.locator('#settings-query-default-add').click();
    const first = await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '2');
    await expect(first.locator('.settings-setting-help')).toContainText('Maximum query threads');
    await page.locator('#settings-query-default-add').click();
    await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '3');
    await page.locator('#settings-query-default-save').click();
    await expect(page.locator('#settings-query-default-message')).toContainText('duplicate');
    expect(await page.evaluate(() => window.localStorage.getItem(query_defaults_key))).toBeNull();
  });

  test('settings catalog combobox virtualizes every ranked result and supports pointer and keyboard selection', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-query-default-add').click();
    const row = page.locator('#settings-query-default-rows .settings-editor-row')
      .filter({ has: page.locator('input:not(:disabled)') })
      .last();
    const nameInput = row.locator('input').nth(0);
    const combobox = page.locator('#settings-catalog-combobox');

    await nameInput.fill('format');
    await expect(combobox).toBeVisible();
    await expect(combobox.getByRole('option').first()).toHaveAttribute('aria-setsize', '15');
    expect(await combobox.getByRole('option').count()).toBeLessThan(15);
    const scrollMetrics = await combobox.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await expect(combobox.getByRole('option').first().locator('.settings-catalog-option-name'))
      .toHaveText('format_csv_delimiter');
    await expect(combobox.getByRole('option').first().locator('.settings-catalog-option-name'))
      .toHaveAttribute('title', 'format_csv_delimiter');
    await expect(combobox.getByRole('option').first().locator('.settings-catalog-option-type'))
      .toHaveAttribute('title', 'Char');
    await expect(combobox.getByRole('option').first().locator('.settings-catalog-option-description'))
      .toHaveAttribute('title', /complete catalog metadata remains available on hover/);
    await expect(row.locator('.settings-setting-warning')).toHaveCount(0);

    await combobox.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    const finalFormatOption = combobox.getByRole('option')
      .filter({ hasText: 'format_test_setting_14' });
    await expect(finalFormatOption).toBeVisible();
    await finalFormatOption.click();
    await expect(nameInput).toHaveValue('format_test_setting_14');

    await nameInput.fill('format');
    await page.keyboard.press('End');
    await expect(combobox.getByRole('option').filter({ hasText: 'format_test_setting_14' }))
      .toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(combobox.getByRole('option').filter({ hasText: 'format_csv_delimiter' }))
      .toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(combobox.getByRole('option').filter({ hasText: 'format_test_setting_01' }))
      .toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(combobox.getByRole('option').filter({ hasText: 'format_csv_delimiter' }))
      .toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Escape');
    await expect(combobox).toBeHidden();
    await expect(row.locator('.settings-setting-warning')).toHaveCount(0);
    await nameInput.fill('format');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(nameInput).toHaveValue('format_test_setting_14');
    await expect(combobox).toBeHidden();

    await nameInput.fill('MaxThreads');
    await expect(combobox.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(nameInput).toHaveValue('max_threads');
    await expect(combobox).toBeHidden();
    await expect(row.locator('.settings-setting-help')).toContainText('Maximum query threads');

    await nameInput.fill('not_a_real_setting');
    await expect(row.locator('.settings-setting-warning')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(row.locator('.settings-setting-warning')).toContainText('unavailable');
  });

  test('settings catalog combobox searches descriptions, supports pointer selection, and stays in the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 420 });
    await openSettings(page);
    await page.locator('#settings-session-add').click();
    const row = page.locator('#settings-session-rows .settings-editor-row')
      .filter({ has: page.locator('input:not(:disabled)') })
      .last();
    const nameInput = row.locator('input').nth(0);
    await nameInput.scrollIntoViewIfNeeded();
    await nameInput.fill('CSV imports and exports');

    const combobox = page.locator('#settings-catalog-combobox');
    await expect(combobox.getByRole('option')).toHaveCount(1);
    const bounds = await combobox.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
        placement: element.dataset.placement,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);

    await combobox.getByRole('option').click();
    await expect(nameInput).toHaveValue('format_csv_delimiter');
    await expect(row.locator('.settings-setting-help')).toHaveAttribute(
      'title', /complete catalog metadata remains available on hover/);
  });

  test('schema-tree editor actions are disabled outside Query and cannot mutate Settings values', async ({ page }) => {
    const databaseHeader = page.locator('.database-header').filter({ hasText: 'default' });
    await databaseHeader.locator('.database-button').click();
    const table = page.locator('.table')
      .filter({ has: page.getByRole('button', { name: 'events', exact: true }) })
      .first();
    const tableRow = table.locator('.table-row');
    await expect(tableRow).toBeVisible();
    await tableRow.locator('.table-link').click();
    const columnName = table.locator('.column-name').filter({ hasText: 'id' }).first();
    await expect(columnName).toBeVisible();

    await setEditorText(page, 'SELECT ');
    await setEditorSelection(page, 7);
    await tableRow.click({ button: 'right' });
    await page.getByRole('button', { name: 'Insert name' }).click();
    await expect(page.locator('#query')).toHaveValue('SELECT default.events');

    await setEditorText(page, 'SELECT guarded;');
    await openSettings(page);
    await page.locator('#settings-query-default-add').click();
    const settingRow = page.locator('#settings-query-default-rows .settings-editor-row')
      .filter({ has: page.locator('input:not(:disabled)') })
      .last();
    const valueInput = settingRow.locator('input').nth(1);
    await valueInput.fill('safe-value');
    await valueInput.focus();

    await expect(databaseHeader.locator('.navigator-header-action')).toBeDisabled();
    await expect(tableRow.locator('.table-menu')).toBeDisabled();
    await expect(columnName).toHaveAttribute('title', 'Available in the Query workspace');
    await databaseHeader.click({ button: 'right' });
    await expect(page.locator('#navigator-context-menu')).not.toHaveClass(/open/);
    await columnName.dblclick();
    await expect(page.locator('#query')).toHaveValue('SELECT guarded;');
    await expect(valueInput).toHaveValue('safe-value');

    await valueInput.focus();
    await page.evaluate(() => insertIntoQueryEditor('DIRECT_GUARD', { mode: 'insert' }));
    await expect(valueInput).toHaveValue('safe-value');
    await expect(page.locator('#query')).toHaveValue(/DIRECT_GUARD/);

    await page.locator('.navigator-connection-menu').click();
    await expect(page.getByRole('button', { name: 'Edit connection' })).toBeVisible();
    await page.keyboard.press('Escape');

    await stubUplot(page);
    for (const workspace of ['dashboard', 'schema']) {
      await page.locator(`#app-view-${workspace}`).click();
      await expect(databaseHeader.locator('.navigator-header-action')).toBeDisabled();
      await expect(tableRow.locator('.table-menu')).toBeDisabled();
      await databaseHeader.click({ button: 'right' });
      await expect(page.locator('#navigator-context-menu')).not.toHaveClass(/open/);
      await columnName.dblclick();
      await expect(page.locator('#query')).toHaveValue(/DIRECT_GUARD/);
    }
  });

  test('connection Query Defaults are URL parameters and never rewrite editor SQL', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('#settings-query-default-scope')).toHaveValue('connection');
    await page.locator('#settings-query-default-add').click();
    await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '3');
    await page.locator('#settings-query-default-save').click();
    await expect(page.locator('#settings-query-default-message')).toContainText('saved');

    await page.locator('#app-view-query').click();
    const sql = 'SELECT 42 AS answer;';
    await setEditorText(page, sql);
    await page.locator('#run').click();

    await expect.poll(() => fakeClickHouse.submissions).toEqual([sql]);
    expect(fakeClickHouse.editorRequests).toHaveLength(1);
    expect(fakeClickHouse.editorRequests[0].body).toBe(sql);
    expect(fakeClickHouse.editorRequests[0].params).toMatchObject({
      max_threads: '3',
      session_check: '1',
      session_timeout: '1800',
    });
  });

  test('Query Defaults and session parameters stay off dashboard and query-log traffic', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-query-default-add').click();
    await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '3');
    await page.locator('#settings-query-default-save').click();

    await page.locator('#app-view-query').click();
    await setEditorText(page, 'SELECT 9;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions.length).toBe(1);
    await expect.poll(() => fakeClickHouse.allRequests.some(request =>
      request.body.includes('FROM system.query_log')
    )).toBe(true);

    await stubUplot(page);
    await page.locator('#app-view-dashboard').click();
    await expect.poll(() => fakeClickHouse.dashboardChartRequests.length).toBe(1);

    const backgroundRequests = [
      ...fakeClickHouse.dashboardRequests,
      ...fakeClickHouse.dashboardChartRequests,
      ...fakeClickHouse.allRequests.filter(request => request.body.includes('FROM system.query_log')),
    ];
    for (const request of backgroundRequests) {
      expect(request.params.session_id).toBeUndefined();
      expect(request.params.session_check).toBeUndefined();
      expect(request.params.max_threads).toBeUndefined();
    }
  });

  test('connection override and suppression resolve over a global Query Default', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-query-default-scope').selectOption('global');
    await page.locator('#settings-query-default-add').click();
    await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '2');
    await page.locator('#settings-query-default-save').click();

    await page.locator('#settings-query-default-scope').selectOption('connection');
    await page.locator('#settings-query-default-add').click();
    const connectionRow = await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '4');
    await page.locator('#settings-query-default-save').click();
    await page.locator('#app-view-query').click();
    await setEditorText(page, 'SELECT 4;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions.length).toBe(1);
    expect(fakeClickHouse.editorRequests[0].params.max_threads).toBe('4');

    await page.locator('#app-view-settings').click();
    await connectionRow.locator('select').selectOption('suppress');
    await page.locator('#settings-query-default-save').click();
    await page.locator('#app-view-query').click();
    await setEditorText(page, 'SELECT 5;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions.length).toBe(2);
    expect(fakeClickHouse.editorRequests[1].params.max_threads).toBeUndefined();
  });

  test('connection Query Default overrides do not leak when the active connection changes', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-query-default-scope').selectOption('global');
    await page.locator('#settings-query-default-add').click();
    await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '2');
    await page.locator('#settings-query-default-save').click();
    await page.locator('#settings-query-default-scope').selectOption('connection');
    await page.locator('#settings-query-default-add').click();
    await addSettingsEditorRow(page, '#settings-query-default-rows', 'max_threads', '4');
    await page.locator('#settings-query-default-save').click();

    const secondConnectionId = await page.evaluate(() => {
      const connection = createConnection('Second');
      saveConnectionRecord(connection);
      return connection.id;
    });
    await expect.poll(() => page.evaluate(() => current_connection_id)).toBe(secondConnectionId);
    await page.locator('#app-view-query').click();
    await setEditorText(page, 'SELECT 2;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions.length).toBe(1);
    expect(fakeClickHouse.editorRequests[0].params.max_threads).toBe('2');
  });

  test('deleting a connection tombstones its Query Defaults at the same revision', async ({ page }) => {
    const result = await page.evaluate(() => {
      const connection = createConnection('Disposable');
      saveConnectionRecord(connection);
      replaceQueryDefaultsScope('connection', connection.id, [
        { name: 'max_threads', value: '4', mode: 'set' },
      ]);
      deleteConnectionById(connection.id);
      const connectionRecord = getSavedConnectionStore().connections.find(candidate => candidate.id == connection.id);
      const defaultRecord = loadQueryDefaults().records.find(candidate => candidate.connection_id == connection.id);
      return {
        connectionDeletedAt: connectionRecord.deleted_at,
        defaultDeletedAt: defaultRecord.deleted_at,
      };
    });

    expect(result.connectionDeletedAt).not.toBe('');
    expect(result.defaultDeletedAt).toBe(result.connectionDeletedAt);
  });

  test('managed Session Settings apply once and editor queries share the checked session', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-session-add').click();
    await addSettingsEditorRow(page, '#settings-session-rows', 'max_threads', '5');
    await page.locator('#settings-session-apply').click();
    await expect(page.locator('#settings-session-message')).toContainText('applied');
    await expect(page.locator('#settings-session-status')).toHaveText('Active');

    expect(fakeClickHouse.sessionRequests).toHaveLength(1);
    expect(fakeClickHouse.sessionRequests[0].body).toBe("SET max_threads = '5'");
    const sessionId = fakeClickHouse.sessionRequests[0].params.session_id;

    await page.locator('#app-view-query').click();
    await setEditorText(page, 'SELECT 5;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 5;']);
    expect(fakeClickHouse.editorRequests[0].params).toMatchObject({
      session_id: sessionId,
      session_check: '1',
    });
  });

  test('session expiry recovers once, lock does not retry, and reload rotates the transport ID', async ({ page }) => {
    await openSettings(page);
    await page.locator('#settings-session-add').click();
    await addSettingsEditorRow(page, '#settings-session-rows', 'max_threads', '6');
    await page.locator('#settings-session-apply').click();
    await expect(page.locator('#settings-session-status')).toHaveText('Active');
    const originalSessionId = fakeClickHouse.sessionRequests.at(-1).params.session_id;

    await page.locator('#app-view-query').click();
    fakeClickHouse.expireNextSession();
    await setEditorText(page, 'SELECT 6;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 6;']);
    const recoveredSessionId = fakeClickHouse.editorRequests.at(-1).params.session_id;
    expect(recoveredSessionId).not.toBe(originalSessionId);
    expect(fakeClickHouse.sessionRequests.at(-1).body).toBe("SET max_threads = '6'");

    fakeClickHouse.lockNextSession();
    await setEditorText(page, 'SELECT 7;');
    await page.locator('#run').click();
    await expect(page.locator('.error-output')).toContainText('SESSION_IS_LOCKED');
    expect(fakeClickHouse.submissions).toEqual(['SELECT 6;']);
    await expect(page.locator('#settings-session-status')).toHaveText('Busy');

    await page.reload();
    await page.locator('#app-view-query').click();
    await setEditorText(page, 'SELECT 8;');
    await page.locator('#run').click();
    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 6;', 'SELECT 8;']);
    const reloadedSessionId = fakeClickHouse.editorRequests.at(-1).params.session_id;
    expect(reloadedSessionId).not.toBe(recoveredSessionId);
    expect(fakeClickHouse.sessionRequests.at(-1).body).toBe("SET max_threads = '6'");
  });
});
