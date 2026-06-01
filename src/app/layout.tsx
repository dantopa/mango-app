import type { Metadata, Viewport } from "next";
import "./globals.css";

import { Providers } from "@/components/providers";
import { PwaRegister } from "@/components/pwa-register";

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
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
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
    <html lang="es" className="dark h-full">
      <body className="min-h-full antialiased font-sans">
        <Providers>{children}</Providers>
        <PwaRegister />
      </body>
    </html>
  );
}
