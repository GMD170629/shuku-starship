const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  httpAgentOptions: {
    keepAlive: false
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: 'http://127.0.0.1:8000/api/:path*'
        }
      ]
    };
  },
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../..')
  }
};

module.exports = nextConfig;
