import { cp, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const baseUrl = process.env.SHUKU_BASE_URL ?? 'http://localhost:3025';
const libraryRoot = resolve(process.env.SHUKU_E2E_LIBRARY_ROOT ?? join(root, 'books', 'acceptance-library'));
const sampleRoot = join(root, 'test-data', 'library');

const env = await loadEnv(join(root, '.env'));
const adminEmail = process.env.ADMIN_EMAIL ?? env.ADMIN_EMAIL ?? 'admin@example.com';
const adminPassword = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD ?? 'starshipnas';

const cookieJar = new Map();
const results = [];

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([^=]+)=(.*)$/.exec(trimmed);
    if (match) values[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function storeCookies(response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const headers = getSetCookie ? getSetCookie() : splitSetCookie(response.headers.get('set-cookie'));
  for (const header of headers) {
    const [pair] = header.split(';');
    const [key, value] = pair.split('=');
    if (key && value !== undefined) cookieJar.set(key.trim(), value.trim());
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/g);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookieJar.size > 0 && !headers.has('cookie')) headers.set('cookie', cookieHeader());
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers,
    redirect: options.redirect ?? 'manual'
  });
  storeCookies(response);
  return response;
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function assertStep(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.error(`FAIL ${name} - ${error.message}`);
    throw error;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function ensureSampleLibrary() {
  await mkdir(libraryRoot, { recursive: true });
  await cp(sampleRoot, libraryRoot, { recursive: true, force: true });
}

let libraryPathId = '';
let scanTaskId = '';
let txtBookId = '';
let pdfBookId = '';

await assertStep('prepare sample library', async () => {
  await ensureSampleLibrary();
  return libraryRoot;
});

await assertStep('public health endpoint responds', async () => {
  const response = await request('/api/health');
  expect(response.status === 200, `expected 200, got ${response.status}`);
});

await assertStep('unauthenticated page redirects to login with next', async () => {
  const response = await request('/organize');
  const location = response.headers.get('location') ?? '';
  expect([307, 308].includes(response.status), `expected redirect, got ${response.status}`);
  expect(location.includes('/login') && location.includes('next=%2Forganize'), `unexpected location ${location}`);
});

await assertStep('unauthenticated API returns 401', async () => {
  const response = await request('/api/books');
  expect(response.status === 401, `expected 401, got ${response.status}`);
});

await assertStep('login with admin credentials', async () => {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  const payload = await json(response);
  expect(response.status === 200 && payload.ok, `login failed: ${response.status} ${JSON.stringify(payload)}`);
  expect(cookieJar.has('shuku_session'), 'login did not set session cookie');
  return payload.data.user.email;
});

await assertStep('authenticated pages render', async () => {
  for (const path of ['/', '/library', '/organize', '/scan-tasks', '/shelves', '/settings']) {
    const response = await request(path);
    const text = await response.text();
    expect(response.status === 200, `${path} returned ${response.status}`);
    expect(!text.includes('登录书库星舰'), `${path} rendered login instead of app`);
  }
});

await assertStep('create or reuse library path', async () => {
  const currentResponse = await request('/api/library-paths');
  const current = await json(currentResponse);
  expect(currentResponse.status === 200 && current.ok, `cannot read library paths: ${currentResponse.status}`);
  const existing = current.data.paths.find((path) => path.rootPath === libraryRoot);
  if (existing) {
    libraryPathId = existing.id;
    return `reused ${libraryPathId}`;
  }
  const response = await request('/api/library-paths', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '验收书库',
      rootPath: libraryRoot,
      enabled: true,
      scanPolicy: 'manual',
      ignoreHidden: true,
      minFileSizeBytes: 0
    })
  });
  const payload = await json(response);
  expect(response.status === 201 && payload.ok, `create path failed: ${response.status} ${JSON.stringify(payload)}`);
  libraryPathId = payload.data.path.id;
  return `created ${libraryPathId}`;
});

await assertStep('start scan and wait for worker completion', async () => {
  const response = await request('/api/scan-tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryPathId })
  });
  const payload = await json(response);
  if (response.status === 409 && payload.error?.details?.scanTaskId) {
    scanTaskId = payload.error.details.scanTaskId;
  } else {
    expect(response.status === 201 && payload.ok, `start scan failed: ${response.status} ${JSON.stringify(payload)}`);
    scanTaskId = payload.data.task.id;
  }

  const deadline = Date.now() + 45000;
  let task;
  while (Date.now() < deadline) {
    const taskResponse = await request(`/api/scan-tasks/${scanTaskId}`);
    const taskPayload = await json(taskResponse);
    expect(taskResponse.status === 200 && taskPayload.ok, `read scan failed: ${taskResponse.status}`);
    task = taskPayload.data.task;
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(task.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  expect(task, 'scan task was not readable');
  expect(task.status === 'COMPLETED', `scan did not complete: ${task.status} ${task.message ?? ''}`);
  expect(task.errorCount === 0, `scan had ${task.errorCount} errors`);
  expect(task.createdCount + task.updatedCount >= 1, 'scan did not create or update any books');
  return `files=${task.totalFiles}, created=${task.createdCount}, updated=${task.updatedCount}, skipped=${task.skippedCount}`;
});

await assertStep('library API returns scanned books', async () => {
  const response = await request('/api/books?visibility=active&pageSize=60&sort=updated');
  const payload = await json(response);
  expect(response.status === 200 && payload.ok, `books failed: ${response.status} ${JSON.stringify(payload)}`);
  const books = payload.data.books;
  const txt = books.find((book) => book.title === 'starship library' && book.format === 'TXT');
  const pdf = books.find((book) => book.title === 'reading notes' && book.format === 'PDF');
  expect(txt, `TXT book not found in ${books.map((book) => book.title).join(', ')}`);
  expect(pdf, `PDF book not found in ${books.map((book) => book.title).join(', ')}`);
  txtBookId = txt.id;
  pdfBookId = pdf.id;
  expect(books.length >= 3, `expected at least 3 scanned books, got ${books.length}`);
  return `${books.length} books`;
});

await assertStep('book detail page and reader page render', async () => {
  for (const path of [`/books/${txtBookId}`, `/reader/${txtBookId}`]) {
    const response = await request(path);
    const text = await response.text();
    expect(response.status === 200, `${path} returned ${response.status}`);
    expect(text.includes('书库星舰') || text.includes('starship library'), `${path} missing expected book text`);
  }
});

await assertStep('TXT content and reading progress work', async () => {
  const contentResponse = await request(`/api/books/${txtBookId}/content`);
  const contentPayload = await json(contentResponse);
  expect(contentResponse.status === 200 && contentPayload.ok, `content failed: ${contentResponse.status}`);
  expect(contentPayload.data.content.includes('第 1 章 书库星舰'), 'TXT content missing expected chapter');

  const progressResponse = await request(`/api/books/${txtBookId}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ readerType: 'txt', position: 'acceptance-check', page: 1, percent: 42 })
  });
  const progressPayload = await json(progressResponse);
  expect(progressResponse.status === 200 && progressPayload.ok, `progress save failed: ${progressResponse.status}`);
  expect(progressPayload.data.progress.percent === 42, `unexpected progress ${progressPayload.data.progress.percent}`);
});

await assertStep('book file streaming works', async () => {
  const txtResponse = await request(`/api/books/${txtBookId}/file`);
  expect(txtResponse.status === 200, `TXT file stream returned ${txtResponse.status}`);
  const txtBody = await txtResponse.text();
  expect(txtBody.includes('旧服务器的风扇声'), 'TXT file stream missing expected text');

  const pdfResponse = await request(`/api/books/${pdfBookId}/file`, {
    headers: { range: 'bytes=0-99' }
  });
  expect([200, 206].includes(pdfResponse.status), `PDF file stream returned ${pdfResponse.status}`);
  expect((await pdfResponse.arrayBuffer()).byteLength > 0, 'PDF stream was empty');
});

await assertStep('cover regeneration never blocks detail workflow', async () => {
  const response = await request(`/api/books/${pdfBookId}/cover/regenerate`, { method: 'POST' });
  const payload = await json(response);
  expect(response.status === 200 && payload.ok, `cover regenerate failed: ${response.status} ${JSON.stringify(payload)}`);
  expect(['READY', 'FAILED'].includes(payload.data.coverStatus), `unexpected cover status ${payload.data.coverStatus}`);

  const coverResponse = await request(`/api/books/${pdfBookId}/cover?size=medium`);
  expect(coverResponse.status === 200, `cover read failed: ${coverResponse.status}`);
  const type = coverResponse.headers.get('content-type') ?? '';
  expect(type.startsWith('image/'), `unexpected cover content-type ${type}`);
  expect((await coverResponse.arrayBuffer()).byteLength > 0, 'cover response was empty');
});

await assertStep('bulk status and tag updates work', async () => {
  const tag = `acceptance-${Date.now()}`;
  const response = await request('/api/books/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [txtBookId], status: 'READING', addTags: [tag] })
  });
  const payload = await json(response);
  expect(response.status === 200 && payload.ok, `bulk update failed: ${response.status} ${JSON.stringify(payload)}`);
  const booksResponse = await request(`/api/books?search=${encodeURIComponent(tag)}&visibility=active`);
  const booksPayload = await json(booksResponse);
  expect(booksResponse.status === 200 && booksPayload.ok, `tag search failed: ${booksResponse.status}`);
  expect(booksPayload.data.books.some((book) => book.id === txtBookId), 'bulk tag was not searchable');
});

await assertStep('book rescan completes', async () => {
  const response = await request(`/api/books/${txtBookId}/rescan`, { method: 'POST' });
  const payload = await json(response);
  if (response.status === 409 && payload.error?.details?.scanTaskId) {
    scanTaskId = payload.error.details.scanTaskId;
  } else {
    expect(response.status === 201 && payload.ok, `rescan failed to start: ${response.status} ${JSON.stringify(payload)}`);
    scanTaskId = payload.data.task.id;
  }

  const deadline = Date.now() + 45000;
  let task;
  while (Date.now() < deadline) {
    const taskResponse = await request(`/api/scan-tasks/${scanTaskId}`);
    const taskPayload = await json(taskResponse);
    expect(taskResponse.status === 200 && taskPayload.ok, `read rescan failed: ${taskResponse.status}`);
    task = taskPayload.data.task;
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(task.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  expect(task?.status === 'COMPLETED', `rescan did not complete: ${task?.status} ${task?.message ?? ''}`);
  expect(task.errorCount === 0, `rescan had ${task.errorCount} errors`);
});

await assertStep('system settings save and read back', async () => {
  const systemName = `书库星舰验收 ${Date.now()}`;
  const response = await request('/api/system-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemName, theme: 'light' })
  });
  const payload = await json(response);
  expect(response.status === 200 && payload.ok, `settings save failed: ${response.status}`);
  const readResponse = await request('/api/system-settings');
  const readPayload = await json(readResponse);
  expect(readResponse.status === 200 && readPayload.ok, `settings read failed: ${readResponse.status}`);
  expect(readPayload.data.settings.systemName === systemName, 'settings did not persist');
});

await assertStep('manual backup can be created, listed, and deleted', async () => {
  const createResponse = await request('/api/backups', { method: 'POST' });
  const createPayload = await json(createResponse);
  expect(createResponse.status === 201 && createPayload.ok, `backup create failed: ${createResponse.status} ${JSON.stringify(createPayload)}`);
  const backupId = createPayload.data.backup.id;
  const listResponse = await request('/api/backups');
  const listPayload = await json(listResponse);
  expect(listResponse.status === 200 && listPayload.ok, `backup list failed: ${listResponse.status}`);
  expect(listPayload.data.backups.some((backup) => backup.id === backupId), 'created backup was not listed');
  const deleteResponse = await request(`/api/backups/${backupId}`, { method: 'DELETE' });
  const deletePayload = await json(deleteResponse);
  expect(deleteResponse.status === 200 && deletePayload.ok, `backup delete failed: ${deleteResponse.status}`);
});

await assertStep('logout invalidates app access', async () => {
  const logoutResponse = await request('/api/auth/logout', { method: 'POST' });
  const logoutPayload = await json(logoutResponse);
  expect(logoutResponse.status === 200 && logoutPayload.ok, `logout failed: ${logoutResponse.status}`);
  cookieJar.clear();
  const response = await request('/settings');
  const location = response.headers.get('location') ?? '';
  expect([307, 308].includes(response.status), `expected redirect after logout, got ${response.status}`);
  expect(location.includes('/login') && location.includes('next=%2Fsettings'), `unexpected location ${location}`);
});

console.log(`\nRuntime acceptance passed: ${results.length} steps against ${baseUrl}`);
