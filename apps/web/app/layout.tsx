import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Restaurant Control System",
  description: "Multi-tenant sistem za upravljanje restoranom",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sr">
      <body className="font-sans">{children}</body>
    </html>
  );
}
