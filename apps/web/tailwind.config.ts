import type { Config } from "tailwindcss";

// ── TableCore — design token sistem ────────────────────────────────────────
// Paleta: duboka mornarsko-plava (primarni tekst/površine/nav), hladna bela
// (pozadina stranica, kartice), Primary Blue kao interaktivni akcenat.
// Status boje su namerno odvojene od brend palete — funkcionalne, ne dekorativne.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Tamne površine (nav, KDS, zaglavlja)
        graphite: { DEFAULT: "#0A1931", 900: "#06111E", 800: "#0F2340", 700: "#1A3D63" },
        // Svetle površine (pozadine stranica, kartice, tekst na tamnom)
        cream: { DEFAULT: "#F6FAFD", 100: "#FFFFFF", 200: "#F6FAFD", 300: "#B3CFE5" },
        // Tekst
        ink: "#0A1931",
        inkSoft: "#1A4A73",
        // Brend akcenat — Primary Blue, za interaktivne elemente i CTA
        gold: { DEFAULT: "#4A7FA7", soft: "#D4E8F4", dark: "#1A3D63" },
        // Linije / granice
        line: "#C8DDEF",
        lineDark: "#1A3D63",
        // Funkcionalne status boje
        success: { DEFAULT: "#15803D", soft: "#DCFCE7" },
        warn: { DEFAULT: "#B45309", soft: "#FEF3C7" },
        danger: { DEFAULT: "#B91C1C", soft: "#FEE2E2" },
        info: { DEFAULT: "#4A7FA7", soft: "#D4E8F4" },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(10,25,49,0.06), 0 1px 12px rgba(10,25,49,0.04)",
        elevated: "0 8px 24px rgba(10,25,49,0.12)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "pulse-soft": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.55" } },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "slide-up": "slide-up 180ms ease-out",
        "pulse-soft": "pulse-soft 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
