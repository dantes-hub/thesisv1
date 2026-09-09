import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKey } from '../lib/client-key.js';

const req = (headers = {}, ip = '10.0.0.1') => ({ headers, ip });

test('a rotating proxy hop does not change the bucket', () => {
  // Render fronts the app with Cloudflare: the last hop differs per request,
  // but the visitor is the same and must share one bucket.
  const a = clientKey(req({ 'cf-connecting-ip': '203.0.113.55', 'x-forwarded-for': '203.0.113.55, 172.71.1.1' }));
  const b = clientKey(req({ 'cf-connecting-ip': '203.0.113.55', 'x-forwarded-for': '203.0.113.55, 172.71.9.9' }));
  assert.equal(a, b);
});

test('different visitors get different buckets', () => {
  const a = clientKey(req({ 'cf-connecting-ip': '198.51.100.10' }));
  const b = clientKey(req({ 'cf-connecting-ip': '198.51.100.20' }));
  assert.notEqual(a, b);
});

test('falls back to the left-most X-Forwarded-For entry', () => {
  const key = clientKey(req({ 'x-forwarded-for': '198.51.100.7, 172.71.2.2, 10.1.1.1' }));
  assert.equal(key, clientKey(req({ 'cf-connecting-ip': '198.51.100.7' })));
});

test('falls back to req.ip with no proxy headers (local dev)', () => {
  const key = clientKey(req({}, '127.0.0.1'));
  assert.ok(key);
  assert.notEqual(key, clientKey(req({}, '127.0.0.2')));
});

test('never returns an empty key', () => {
  assert.ok(clientKey({ headers: {}, ip: undefined }));
  assert.ok(clientKey({ headers: { 'x-forwarded-for': '  ' }, ip: undefined }));
});

test('IPv6 addresses from one host share a /64 bucket', () => {
  const a = clientKey(req({ 'cf-connecting-ip': '2001:db8:1234:5678::1' }));
  const b = clientKey(req({ 'cf-connecting-ip': '2001:db8:1234:5678::99ff' }));
  assert.equal(a, b, 'same /64 should share a bucket');
  const c = clientKey(req({ 'cf-connecting-ip': '2001:db8:9999:0000::1' }));
  assert.notEqual(a, c, 'a different /64 is a different visitor');
});
