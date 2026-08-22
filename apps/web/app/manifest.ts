import type { MetadataRoute } from "next";
import { APP_NAME } from "../components/branding/constants";

/**
 * P3.1 — Web App Manifest (Next.js file-based convention: automatically
 * served at /manifest.webmanifest AND automatically linked in <head> —
 * no manual <link rel="manifest"> needed).
 *
 * start_url/scope = "/" — the existing root page (app/page.tsx) already
 * does the correct thing for every launch context: redirects to /login
 * when there's no session, or to the role-appropriate workspace
 * (resolveRedirectPath) when a session cookie already exists. Since an
 * installed PWA shares the same origin's cookies/localStorage as the
 * browser, this preserves Shared POS device registration, personal-device
 * PIN login, and role routing with ZERO additional code — audited, not
 * reinvented (specification #5/#6).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${APP_NAME} Restaurant POS`,
    short_name: APP_NAME,
    description: "TableCore — sistem za upravljanje restoranom: porudžbine, naplata, kuhinja/bar, izveštaji.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    lang: "sr",
    background_color: "#F6FAFD",
    theme_color: "#0A1931",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
