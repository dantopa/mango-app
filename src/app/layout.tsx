import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";
import { PwaRegister } from "@/components/pwa-register";

const geistSans = Geist({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Maquinita — Finanzas personales",
  description:
    "Patrimonio neto, gastos y objetivos de ahorro consolidados en USD.",
  applicationName: "Maquinita",
  appleWebApp: {
    capable: true,
    title: "Maquinita",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`dark h-full ${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-full antialiased font-sans">
        <PwaRegister>
          <Providers>{children}</Providers>
        </PwaRegister>
      </body>
    </html>
  );
}
