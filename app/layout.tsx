import type { Metadata } from "next";
import "./fonts/fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "J.A.R.V.I.S. · Personal AI Workspace",
  description:
    "Persönlicher KI-Assistent für Studium, Aufgaben, Termine und Finanzen.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <div aria-hidden="true" className="jarvis-ambient">
          <div className="jarvis-ambient-blob" />
        </div>
        {children}
      </body>
    </html>
  );
}
