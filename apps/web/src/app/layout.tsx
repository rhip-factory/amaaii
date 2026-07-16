import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { fraunces, jakarta } from "./fonts";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Amaaii — your pregnancy companion",
  description: "Your AI pregnancy companion. Journal, track, and get safe guidance.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/img/logo-mark-purple.png",
    apple: "/img/logo-mark-purple.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#7C47AF",
  // Committed-light design: opts out of browser auto-darkening (see the
  // matching `color-scheme: only light` in styles/tokens.css).
  colorScheme: "only light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${fraunces.variable}`}>
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
