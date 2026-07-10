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

async function startFakeClickHouse() {
  const submissions = [];
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
});
