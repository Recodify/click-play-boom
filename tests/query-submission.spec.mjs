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
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(value));
}

function queryResponse(response) {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/x-ndjson',
    'X-ClickHouse-Format': 'JSONStringsEachRowWithProgress',
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
  const submissions = [];
  const dashboardRequests = [];
  const dashboardChartRequests = [];
  const schemaRequests = [];
  const waiters = [];

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
    if (body.includes('SELECT version() AS v')) {
      jsonResponse(response, { v: 'test', t: 123 });
      return;
    }

    if (body.includes('FROM system.databases')) {
      jsonResponse(response, { data: [{ database: 'default', current: 1 }] });
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
      && body.includes("database = 'click_play_boom'")
      && body.includes("table = 'schema_mv_targets'")) {
      compactResponse(response, ['name'], ['String'], schemaTargetMode === 'compat'
        ? [['database'], ['name'], ['target_database'], ['target_table']]
        : []);
      return;
    }

    if (body.includes('FROM system.dashboards')) {
      const requestUrl = new URL(request.url, 'http://fake-clickhouse.test');
      dashboardRequests.push({
        body,
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
      const requestUrl = new URL(request.url, 'http://fake-clickhouse.test');
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
      const requestUrl = new URL(request.url, 'http://fake-clickhouse.test');
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
        ['default', 'events_mv', 'MaterializedView', 'MaterializedView', 'CREATE MATERIALIZED VIEW default.events_mv TO default.events_summary AS SELECT count() FROM default.events', '', '', '', '', 0, 0, '', schemaTargetMode === 'missing' ? '' : 'default', schemaTargetMode === 'missing' ? '' : 'events_summary', schemaTargetMode === 'native' ? ['default.events_summary'] : [], ['default.events']],
        ['default', 'events_summary', 'AggregatingMergeTree', 'AggregatingMergeTree ORDER BY tuple()', 'CREATE TABLE default.events_summary (c UInt64) ENGINE = AggregatingMergeTree ORDER BY tuple()', '', '', '', '', 1, 64, '', '', '', [], []],
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
    dashboardRequests,
    dashboardChartRequests,
    schemaRequests,
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

test.describe('query submission safety', () => {
  let fakeClickHouse;

  test.beforeEach(async ({ page }) => {
    fakeClickHouse = await startFakeClickHouse();
    await openApp(page, fakeClickHouse.url);
  });

  test.afterEach(async () => {
    await fakeClickHouse?.close();
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

  test('run button preserves selected text when focus moves to the button', async ({ page }) => {
    const script = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    await setEditorText(page, script);
    await selectEditorText(page, script, 'SELECT 2;');

    await page.locator('#run').click();

    await expect.poll(() => fakeClickHouse.submissions).toEqual(['SELECT 2;']);
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
    await page.reload();
    await expect(page.locator('#schema_workspace')).toBeVisible();
    await expect(page.locator('.schema-node').filter({ hasText: 'events_summary' }).first()).toBeVisible();
    await expect.poll(() => fakeClickHouse.schemaRequests.some(request =>
      request.user == 'default' && request.password == 'secret'
    )).toBe(true);
  });

  test('schema workspace uses optional MV target compatibility table on older servers', async ({ page }) => {
    await fakeClickHouse.close();
    fakeClickHouse = await startFakeClickHouse({ schemaTargetMode: 'compat' });
    await page.evaluate(() => window.localStorage.clear());
    await openAppWithPassword(page, fakeClickHouse.url, 'secret');

    await page.locator('#app-view-schema').click();

    await expect(page.locator('#schema_workspace')).toBeVisible();
    await expect(page.locator('#schema-status')).toContainText('MV targets: compat table');
    await expect(page.locator('.schema-arrow')).toHaveCount(2);
    await expect.poll(() => fakeClickHouse.schemaRequests.some(request =>
      request.body.includes('LEFT JOIN') && request.body.includes('click_play_boom.schema_mv_targets')
    )).toBe(true);
  });

  test('database menu generates schema compatibility table DDL', async ({ page }) => {
    const ddl = await page.evaluate(() => buildSchemaCompatTableStatement('default'));

    expect(ddl).toContain('CREATE DATABASE IF NOT EXISTS click_play_boom');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS click_play_boom.schema_mv_targets');
    expect(ddl).toContain("('default', 'materialized_view_name', 'default', 'target_table_name')");
  });
});
