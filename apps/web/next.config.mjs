/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are plain ESM; let Next compile them alongside the app.
  transpilePackages: ['@atl/qr-token', '@atl/qr-render', '@atl/vn-text'],

  // PGlite ships a WASM Postgres used as the zero-setup dev database. It must
  // stay an external require on the server, not be bundled by webpack.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default nextConfig;
