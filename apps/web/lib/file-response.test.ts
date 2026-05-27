import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { notModified, parseByteRange, shouldUseRange, weakEtag } from './file-response';

describe('file response helpers', () => {
  it('parses standard, open-ended, and suffix ranges', () => {
    assert.deepEqual(parseByteRange('bytes=10-19', 100), { type: 'range', range: { start: 10, end: 19 } });
    assert.deepEqual(parseByteRange('bytes=90-', 100), { type: 'range', range: { start: 90, end: 99 } });
    assert.deepEqual(parseByteRange('bytes=-10', 100), { type: 'range', range: { start: 90, end: 99 } });
  });

  it('rejects invalid and unsatisfiable ranges', () => {
    assert.deepEqual(parseByteRange('items=1-2', 100), { type: 'invalid' });
    assert.deepEqual(parseByteRange('bytes=-0', 100), { type: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=100-120', 100), { type: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=20-10', 100), { type: 'unsatisfiable' });
  });

  it('handles ETag and Last-Modified validators', () => {
    const etag = weakEtag(1024, 1700000000000);
    const lastModified = new Date('2026-05-27T01:00:00.000Z').toUTCString();
    assert.equal(notModified(new Request('http://local', { headers: { 'If-None-Match': etag } }), etag, lastModified), true);
    assert.equal(notModified(new Request('http://local', { headers: { 'If-Modified-Since': lastModified } }), etag, lastModified), true);
    assert.equal(shouldUseRange(new Request('http://local', { headers: { 'If-Range': etag } }), etag, lastModified), true);
    assert.equal(shouldUseRange(new Request('http://local', { headers: { 'If-Range': '"different"' } }), etag, lastModified), false);
  });
});
