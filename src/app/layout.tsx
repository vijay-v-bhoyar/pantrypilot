import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "PantryPilot — Give with purpose. Deliver with proof.",
  description:
    "A community pantry workspace connecting giving, inventory, approved purchasing and recovery.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
