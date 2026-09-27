/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript (main: "index.ts") — without this,
  // webpack treats them as external CJS and cannot handle .ts entry points in
  // production builds. transpilePackages tells Next.js to include them in its
  // own compilation pass.
  transpilePackages: ['@rcs/db', '@rcs/auth'],
  // BRANDED QR MENU V1 — restaurant logo/cover/menu-item images are plain
  // admin-pasted URLs (same long-established convention as
  // RestaurantSettings.logoUrl/MenuItem.imageUrl — no upload pipeline
  // exists anywhere in this app), so the hostname can't be known in
  // advance. Wildcard remotePatterns is next/image's documented approach
  // for exactly this case; images are still only ever fetched/optimized,
  // never executed.
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
}

module.exports = nextConfig
