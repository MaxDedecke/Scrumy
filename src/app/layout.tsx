import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scrumy",
  description: "Agenten-Scrum-Teams, die Individualsoftware für Kunden bauen und warten.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-100 font-sans">
        {children}
      </body>
    </html>
  );
}
