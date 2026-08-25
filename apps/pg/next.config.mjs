/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@atl/db', '@atl/qr-token', '@atl/scan-queue', '@atl/vn-text'],
  serverExternalPackages: ['@electric-sql/pglite'],
};
export default nextConfig;
