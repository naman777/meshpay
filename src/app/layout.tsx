import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "MeshPay — Payments beyond connectivity",
  description: "An interactive encrypted offline payment mesh simulator.",
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
