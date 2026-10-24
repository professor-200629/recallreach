import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RecallReach — Every batch. Every handoff.",
  description: "Evidence-led medicine recall investigations and mock recall drills.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
