import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const configPath = require.resolve('../next.config.js');

async function loadRewrites(target?: string) {
  const previous = process.env.API_PYTHON_PORT;
  const previousSkipRootEnv = process.env.SHUKU_SKIP_ROOT_ENV_LOAD;
  process.env.SHUKU_SKIP_ROOT_ENV_LOAD = 'true';
  if (target === undefined) {
    delete process.env.API_PYTHON_PORT;
  } else {
    process.env.API_PYTHON_PORT = target;
  }
  delete require.cache[configPath];
  try {
    const config = require(configPath) as { rewrites?: () => Promise<unknown> };
    return await config.rewrites?.();
  } finally {
    delete require.cache[configPath];
    if (previous === undefined) {
      delete process.env.API_PYTHON_PORT;
    } else {
      process.env.API_PYTHON_PORT = previous;
    }
    if (previousSkipRootEnv === undefined) {
      delete process.env.SHUKU_SKIP_ROOT_ENV_LOAD;
    } else {
      process.env.SHUKU_SKIP_ROOT_ENV_LOAD = previousSkipRootEnv;
    }
  }
}

test('always rewrites API requests to the local Python backend', async () => {
  assert.deepEqual(await loadRewrites(), {
    beforeFiles: [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:8000/api/:path*'
      }
    ]
  });
});

test('uses API_PYTHON_PORT for the local Python backend rewrite', async () => {
  assert.deepEqual(await loadRewrites('8123'), {
    beforeFiles: [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:8123/api/:path*'
      }
    ]
  });
});
