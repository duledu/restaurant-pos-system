import type { Config } from "tailwindcss";

// ── Restoran Evropa MM — design token sistem ────────────────────────────
// Paleta: tamna grafitna (primarni tekst/površine), topla krem (pozadina),
// diskretan zlatni akcenat (samo za ključne CTA i brend momente — NE za
// svaki dugme, da ne postane dekorativno umesto funkcionalno).
// Status boje su namerno odvojene od brend palete — funkcionalne, ne
// dekorativne (zelena=uspeh/aktivno, ćilibar=upozorenje/čeka, crvena=greška).
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Površine
        graphite: { DEFAULT: "#1E1D1B", 900: "#141312", 800: "#1E1D1B", 700: "#2A2825" },
        cream: { DEFAULT: "#F7F3EC", 100: "#FCFAF6", 200: "#F7F3EC", 300: "#EDE6D8" },
        // Tekst
        ink: "#1E1D1B",
        inkSoft: "#5C5850",
        // Brend akcenat — zlatna, koristi se ŠTEDLJIVO (CTA, aktivni tab, brend mark)
        gold: { DEFAULT: "#B8935A", soft: "#F0E6D4", dark: "#8F6E3F" },
        // Linije/granice
        line: "#E4DFD3",
        lineDark: "#3A3733",
        // Funkcionalne status boje (odvojeno od brend palete)
        success: { DEFAULT: "#2F6D4F", soft: "#E6F0EA" },
        warn: { DEFAULT: "#B5541A", soft: "#FBEEE4" },
        danger: { DEFAULT: "#B3261E", soft: "#FBEAE9" },
        info: { DEFAULT: "#2F5D50", soft: "#E8F0ED" },
      },
      fontFamily: {
        // Display: karakterna serif za brend momente (login, admin header)
        display: ["Fraunces", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(30,29,27,0.04), 0 1px 12px rgba(30,29,27,0.03)",
        elevated: "0 8px 24px rgba(30,29,27,0.10)",
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
