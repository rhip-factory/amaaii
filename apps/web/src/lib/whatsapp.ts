// The Amaaii WhatsApp number, for links from the app back to the chat.
// Build-time (NEXT_PUBLIC_WHATSAPP_NUMBER, digits or +E.164); unset means
// no links are shown rather than a broken one.
const RAW = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_WHATSAPP_NUMBER) || "";
const DIGITS = RAW.replace(/\D/g, "");

export const WHATSAPP_NUMBER: string | null = DIGITS.length >= 8 ? DIGITS : null;

export function whatsappLink(text?: string): string | null {
  if (!WHATSAPP_NUMBER) return null;
  return `https://wa.me/${WHATSAPP_NUMBER}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function whatsappDisplay(): string | null {
  return WHATSAPP_NUMBER ? `+${WHATSAPP_NUMBER}` : null;
}
