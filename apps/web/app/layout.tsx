import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TableCore | Restaurant Control System",
  description: "TableCore — sistem za upravljanje restoranom",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sr">
      <body className="font-sans">{children}</body>
    </html>
  );
}
