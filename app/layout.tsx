import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import {
  allPalettes, APP_DESCRIPTION, APP_TITLE, DEFAULT_THEME_ID, DEFAULT_THEME_MODE,
  THEME_MODE_STORAGE_KEY, THEME_STORAGE_KEY,
} from "@/lib/branding";

// One font, everywhere — Inter (self-hosted via next/font, no external
// request at runtime, zero layout shift). globals.css falls back to the
// system stack if the variable is absent. Do not add a second display/mono
// face — differentiate headings/data via weight, size, and tracking only.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: APP_TITLE,
  description: APP_DESCRIPTION
};

// Applies the cached theme + mode before paint so switching pages/reloading
// doesn't flash back to the defaults while settings load from the server.
// It must be a plain string (it runs before any JS bundle loads), so the
// palettes are generated from lib/branding.ts at build time and embedded as
// JSON — one source of truth, nothing to keep in sync by hand.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var P = ${JSON.stringify(allPalettes())};
    var id = localStorage.getItem("${THEME_STORAGE_KEY}");
    var mode = localStorage.getItem("${THEME_MODE_STORAGE_KEY}");
    if (mode !== "light" && mode !== "dark") mode = "${DEFAULT_THEME_MODE}";
    if (!P[id + ":" + mode]) id = "${DEFAULT_THEME_ID}";
    var palette = P[id + ":" + mode];
    var root = document.documentElement;
    for (var key in palette) root.style.setProperty(key, palette[key]);
    root.dataset.theme = id;
    root.dataset.mode = mode;
  } catch (e) {}
})();
`;

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={inter.variable}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
