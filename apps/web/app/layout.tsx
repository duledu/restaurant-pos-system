import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "../components/branding/constants";

export const metadata: Metadata = {
  title: `${APP_NAME} | Restaurant Control System`,
  description: `${APP_NAME} — sistem za upravljanje restoranom`,
  icons: {
    icon: "/branding/tablecore-favicon-512.png",
    shortcut: "/branding/tablecore-favicon-512.png",
    apple: "/branding/tablecore-favicon-512.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sr">
      <body className="font-sans">{children}</body>
    </html>
  );
}
