import withSerwist from '@serwist/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['chokidar', 'gray-matter', '@prisma/client', 'pdfjs-dist'],
  async headers() {
    return [
      {
        source: '/manifest.webmanifest',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET' },
        ],
      },
      {
        source: '/icons/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET' },
        ],
      },
    ];
  },
};

// Serwist uses webpack, which conflicts with Turbopack (Next.js 16 default).
// In dev we skip it; in production we build with --webpack.
const isProd = process.env.NODE_ENV === 'production';

export default isProd
  ? withSerwist({
      swSrc: 'sw/service-worker.js',
      swDest: 'public/sw.js',
      cacheOnNavigation: true,
      reloadOnOnline: true,
    })(nextConfig)
  : nextConfig;
