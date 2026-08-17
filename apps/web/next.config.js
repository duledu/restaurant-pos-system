/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript (main: "index.ts") — without this,
  // webpack treats them as external CJS and cannot handle .ts entry points in
  // production builds. transpilePackages tells Next.js to include them in its
  // own compilation pass.
  transpilePackages: ['@rcs/db', '@rcs/auth'],
}

module.exports = nextConfig
