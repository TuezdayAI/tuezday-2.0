import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tuezday",
  description: "GTM that remembers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <span className="logo">Tuezday</span>
          <span className="tagline">GTM that remembers</span>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
