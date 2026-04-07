/** @type {import('next').NextConfig} */
const VPS_URL = process.env.VPS_URL || 'https://reduces-foot-alto-verbal.trycloudflare.com';

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: [
      'lucide-react',
      '@dnd-kit/core',
      '@dnd-kit/sortable',
      'date-fns',
    ],
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'http', hostname: '187.127.11.117' },
      { protocol: 'https', hostname: '*.trycloudflare.com' },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${VPS_URL}/api/:path*`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${VPS_URL}/socket.io/:path*`,
      },
    ];
  },
};
module.exports = nextConfig;
