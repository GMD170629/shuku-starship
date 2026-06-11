const path = require('path');
const fs = require('fs');

const repoRoot = path.join(__dirname, '../..');
const rootEnvPath = path.join(repoRoot, '.env');
if (process.env.SHUKU_SKIP_ROOT_ENV_LOAD !== 'true' && fs.existsSync(rootEnvPath)) {
  const rootEnv = fs.readFileSync(rootEnvPath, 'utf8');
  const overrideRootEnv = process.env.NODE_ENV !== 'production';
  for (const line of rootEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || (!overrideRootEnv && process.env[match[1]] !== undefined)) continue;
    const name = match[1];
    let value = match[2].replace(/^['"]|['"]$/g, '');
    if ((name === 'MONITOR_ROOT' || name === 'STORAGE_ROOT') && value && !path.isAbsolute(value)) {
      value = path.join(repoRoot, value);
    }
    process.env[name] = value;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@shuku/database', '@shuku/scanner', '@shuku/shared', '@shuku/reader-core'],
  async rewrites() {
    const port = process.env.API_PYTHON_PORT || '8000';
    const target = `http://127.0.0.1:${port}`;
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${target}/api/:path*`
        }
      ]
    };
  },
  webpack: (config) => {
    // Workspace packages use NodeNext-style emitted .js specifiers in TypeScript source.
    // Teach webpack to resolve those specifiers back to .ts files during Next's transpilation step.
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs']
    };
    return config;
  },
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../..'),
    outputFileTracingIncludes: {
      '/*': [
        './node_modules/.pnpm/sharp@*/node_modules/sharp/**/*',
        './node_modules/.pnpm/@img+sharp-*/node_modules/@img/sharp-*',
        './node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/sharp-libvips-*',
        './node_modules/.pnpm/@img+colour@*/node_modules/@img/colour/**/*'
      ]
    }
  }
};

module.exports = nextConfig;
