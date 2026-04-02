/** @type {import('next').NextConfig} */
const VPS_URL = process.env.VPS_URL || 'http://187.127.11.117:3001';

const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'http', hostname: '187.127.11.117' },
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
