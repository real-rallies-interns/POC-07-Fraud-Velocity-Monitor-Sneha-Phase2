import type { Metadata } from "next";
import "./globals.css";

// BUG FIX #10: Title was "Create Next App" (default Next.js template value).
// Updated to reflect the actual project name as required by VAR FIX #1.
export const metadata: Metadata = {
  title: "Fraud Velocity Monitor | Real Rails",
  description:
    "Real-time payment fraud and card testing pattern detection — PoC #07",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      {/*
        DNA GUARDRAIL:
        1. bg-[#030712] = mandatory Obsidian Black background
        2. text-[#E2E8F0] = slate-200 foreground
        3. text-sm = anchors base font to 14px so text is readable
        4. font-sans = Space Grotesk via globals.css --font-space

        BUG FIX #11: overflow-x-hidden was blocking horizontal scroll on the
        Review Queue table (which has 9 columns). Changed to overflow-x-auto
        so wide tables scroll rather than clip silently.
      */}
      <body className="min-h-full bg-[#030712] text-[#E2E8F0] text-sm font-sans overflow-x-auto">
        {children}
      </body>
    </html>
  );
}