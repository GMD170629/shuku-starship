/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@shuku/database', '@shuku/scanner', '@shuku/shared', '@shuku/reader-core']
};

module.exports = nextConfig;
