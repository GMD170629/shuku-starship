import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Source } from '@prisma/client';
import { inferDownloadTaskType } from '../../download-tasks';
import { getSourceProvider } from '../provider-registry';
import { telegramZLibraryProvider } from './telegram-zlibrary-provider';

function source(config: Record<string, unknown>): Source {
  return {
    id: 'source-telegram',
    name: 'Z-Library Bot',
    kind: 'novel',
    providerType: 'telegram',
    enabled: true,
    priority: 100,
    config,
    credentialsKey: null,
    capabilities: null,
    rateLimit: null,
    lastTestAt: null,
    lastTestStatus: null,
    lastError: null,
    createdAt: new Date('2026-06-05T00:00:00.000Z'),
    updatedAt: new Date('2026-06-05T00:00:00.000Z')
  } as Source;
}

test('telegram provider is registered as Z-Library Telegram Bot source provider', () => {
  const provider = getSourceProvider('telegram');
  assert.equal(provider.providerType, 'telegram');
  assert.equal(provider.capabilities.search, true);
  assert.equal(provider.capabilities.telegram, true);
});

test('telegram provider returns a handoff result when gateway is not configured', async () => {
  const results = await telegramZLibraryProvider.search(source({ botUsername: '@zlib_test_bot' }), {
    keyword: '星际远航',
    kind: 'novel'
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].providerType, 'telegram');
  assert.equal(results[0].downloadAvailable, false);
  assert.equal(results[0].externalUrl, 'https://t.me/zlib_test_bot');
  assert.match(results[0].title, /Z-Library Telegram Bot/);
});

test('telegram provider maps gateway results and exposes direct download metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.provider, 'zlibrary_telegram_bot');
    assert.equal(body.keyword, 'orbital mechanics');
    return new Response(JSON.stringify({
      results: [{
        externalId: 'book-1',
        title: 'Orbital Mechanics',
        author: 'Ada Example',
        format: 'epub',
        size: '2 MB',
        downloadUrl: 'https://example.com/orbital.epub'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const results = await telegramZLibraryProvider.search(source({
      botUsername: 'zlib_test_bot',
      mode: 'gateway',
      gatewayUrl: 'https://gateway.example/search',
      downloadEnabled: true
    }), { keyword: 'orbital mechanics', kind: 'novel' });

    assert.equal(results.length, 1);
    assert.equal(results[0].externalId, 'book-1');
    assert.equal(results[0].downloadAvailable, true);
    assert.deepEqual(results[0].downloadMeta, {
      type: 'telegram_zlibrary',
      botUsername: 'zlib_test_bot',
      fileId: undefined,
      messageId: undefined,
      downloadUrl: 'https://example.com/orbital.epub'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telegram direct download urls are queued as http downloads', () => {
  assert.equal(inferDownloadTaskType('telegram', { type: 'telegram_zlibrary', downloadUrl: 'https://example.com/book.epub' }), 'http');
  assert.equal(inferDownloadTaskType('telegram', { type: 'telegram_zlibrary', messageId: '123' }), 'telegram');
});
