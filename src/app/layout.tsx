import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scrumy",
  description: "Agenten-Scrum-Teams, die Individualsoftware für Kunden bauen und warten.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-100 font-sans">
        <header className="border-b border-neutral-900">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-sky-500 text-sm text-white">
                S
              </span>
              Scrumy
            </Link>
            <nav className="flex items-center gap-5 text-sm text-neutral-400">
              <Link href="/" className="hover:text-neutral-100">
                Kunden
              </Link>
              <Link href="/settings/llm-profiles" className="hover:text-neutral-100">
                Einstellungen
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
