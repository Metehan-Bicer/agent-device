import assert from 'node:assert/strict';
import { test } from 'vitest';
import fc from 'fast-check';
import { AppError } from '@agent-device/kernel/errors';
import {
  resolveRuntimeServerUrl,
  resolveRuntimeTransportHints,
  trimRuntimeValue,
} from './runtime-transport-hints.ts';

test('resolves HTTP and HTTPS bundle URLs with their default ports', () => {
  assert.deepEqual(
    resolveRuntimeTransportHints({ bundleUrl: 'http://metro.example.test/index.bundle' }),
    { host: 'metro.example.test', port: 80, scheme: 'http' },
  );
  assert.deepEqual(
    resolveRuntimeTransportHints({ bundleUrl: 'https://metro.example.test/index.bundle' }),
    { host: 'metro.example.test', port: 443, scheme: 'https' },
  );
});

test('explicit host and port take precedence over bundle URL values', () => {
  assert.deepEqual(
    resolveRuntimeTransportHints({
      metroHost: '  explicit.example.test ',
      metroPort: 9090,
      bundleUrl: 'https://bundle.example.test:8081/index.bundle',
    }),
    { host: 'explicit.example.test', port: 9090, scheme: 'https' },
  );
});

test('trims values, ignores invalid ports, and returns undefined for incomplete hints', () => {
  assert.equal(trimRuntimeValue('   '), undefined);
  assert.equal(trimRuntimeValue('  metro.example.test  '), 'metro.example.test');
  assert.equal(resolveRuntimeTransportHints(undefined), undefined);
  assert.equal(resolveRuntimeTransportHints({ metroHost: 'metro.example.test' }), undefined);
  assert.equal(resolveRuntimeTransportHints({ metroPort: 0 }), undefined);
  assert.deepEqual(
    resolveRuntimeTransportHints({ metroHost: ' metro.example.test ', metroPort: 65_536 }),
    undefined,
  );
});

test('invalid bundle URLs retain the existing typed argument error', () => {
  assert.throws(
    () => resolveRuntimeTransportHints({ bundleUrl: 'not a URL' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.message, 'Invalid runtime bundle URL: not a URL');
      return true;
    },
  );
  assert.throws(() => resolveRuntimeServerUrl({ metroHost: 'bad host', metroPort: 8081 }));
});

test('unsupported bundle schemes do not complete an otherwise missing transport', () => {
  assert.equal(
    resolveRuntimeTransportHints({ bundleUrl: 'ftp://metro.example.test/index.bundle' }),
    undefined,
  );
  assert.deepEqual(
    resolveRuntimeTransportHints({
      metroHost: 'metro.example.test',
      metroPort: 8081,
      bundleUrl: 'ftp://bundle.example.test/index.bundle',
    }),
    { host: 'metro.example.test', port: 8081, scheme: 'http' },
  );
});

test('server URLs retain mounts and normalize entries, default ports, and IPv6', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('tenant-42', 'workspace', 'metro'), { maxLength: 3 }),
      fc.constantFrom(
        'index.bundle',
        'index.js',
        'main.jsbundle',
        '.expo/.virtual-metro-entry.bundle',
      ),
      fc.constantFrom('https://metro.example.test', 'http://[::1]:8082'),
      (segments, entry, origin) => {
        const mount = segments.length ? `/${segments.join('/')}` : '';
        const result = resolveRuntimeServerUrl({
          bundleUrl: `${origin}${mount}/${entry}?platform=ios&dev=true`,
        });
        assert.equal(result?.toString(), `${origin}${mount || '/'}`);
      },
    ),
  );
});
