import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledger — your next chapter",
  description:
    "An evidence-backed view of your job search. Independent attempts, clear timelines, and honest monitoring coverage.",
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await headers(); // Dynamic rendering lets Next apply the per-request CSP nonce.
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
