const path = require('path');
const fs = require('fs');

const repoRoot = path.join(__dirname, '../..');
const rootEnvPath = path.join(repoRoot, '.env');
if (fs.existsSync(rootEnvPath)) {
  const rootEnv = fs.readFileSync(rootEnvPath, 'utf8');
  for (const line of rootEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const name = match[1];
    let value = match[2].replace(/^['"]|['"]$/g, '');
    if ((name === 'BOOKS_ROOT' || name === 'STORAGE_ROOT') && value && !path.isAbsolute(value)) {
      value = path.join(repoRoot, value);
    }
    process.env[name] = value;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@shuku/database', '@shuku/scanner', '@shuku/shared', '@shuku/reader-core'],
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
