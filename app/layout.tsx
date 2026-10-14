import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledger — your next chapter",
  description:
    "An evidence-backed view of your job search. Independent attempts, clear timelines, and honest monitoring coverage.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f2" },
    { media: "(prefers-color-scheme: dark)", color: "#111612" },
  ],
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await headers(); // Dynamic rendering lets Next apply the per-request CSP nonce.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
