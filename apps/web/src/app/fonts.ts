// Self-hosted via next/font/google: fetched once at build time and served
// from our own origin — no runtime request to fonts.googleapis.com, which
// matters for low-connectivity users on the WhatsApp/PWA audience this
// app targets.
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";

export const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

// Display face: used sparingly (screen titles, the greeting, big numbers)
// at soft/low-contrast optical sizing per the brand — weights 500-600 only.
// `weight: "variable"` is required to opt into the SOFT/opsz axes below;
// CSS still pins font-weight 500/600 wherever this face is used.
export const fraunces = Fraunces({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT"],
});
