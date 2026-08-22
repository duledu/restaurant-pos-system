import type { Metadata, Viewport } from "next";
import "./globals.css";
import "../styles/print-thermal.css";
import "../styles/print-report.css";
import { APP_NAME } from "../components/branding/constants";
import { OfflineBanner } from "../components/system/OfflineBanner";

export const metadata: Metadata = {
  title: `${APP_NAME} | Restaurant Control System`,
  description: `${APP_NAME} — sistem za upravljanje restoranom`,
  // Postojeći favicon (branding/) OSTAJE nepromenjen — PWA ikone ispod su
  // ADITIVNE, ne zamena (specifikacija #8: "Do not remove working icons").
  icons: {
    icon: "/branding/tablecore-favicon-512.png",
    shortcut: "/branding/tablecore-favicon-512.png",
    apple: "/icons/apple-touch-icon.png",
  },
  // iOS nema web manifest podršku kao Android/Chrome — ovo je standardni,
  // minimalni skup meta tagova za "Dodaj na početni ekran" (specifikacija #12).
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    statusBarStyle: "black-translucent",
  },
};

// Next.js 14: viewport/themeColor su ODVOJENI od `metadata` (stariji
// `metadata.viewport`/`metadata.themeColor` su deprecated). Namerno NEMA
// maximumScale/userScalable:false — specifikacija #11 zabranjuje gašenje
// zума bez jakog razloga za pristupačnost, a ovde takvog razloga nema.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A1931",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sr">
      <body className="font-sans">
        <OfflineBanner />
        {children}
      </body>
    </html>
  );
}
