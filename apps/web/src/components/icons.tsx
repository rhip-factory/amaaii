// Inline stroke icons — same visual language (24px viewBox, 2px stroke,
// round caps) as the icons already used in public/index.html, redrawn so
// this app has no asset dependency on public/.
import type { SVGProps } from "react";

function Base(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M3 12 12 4l9 8" />
      <path d="M5 10v10h14V10" />
    </Base>
  );
}

export function ChatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Base>
  );
}

export function JournalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H18a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 1 4 18.5v-14z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </Base>
  );
}

export function InsightsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-6" />
    </Base>
  );
}

export function ProfileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Base>
  );
}

export function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a1.5 1.5 0 0 0 1.29 2.25h17.78A1.5 1.5 0 0 0 22.18 18L13.71 3.86a1.5 1.5 0 0 0-2.42 0z" />
    </Base>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </Base>
  );
}

export function PhoneCallIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </Base>
  );
}

export function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Base>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base strokeWidth={2.5} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Base>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base strokeWidth={2.4} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Base>
  );
}

export function MinusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base strokeWidth={2.4} {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </Base>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base strokeWidth={2.2} {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Base>
  );
}

export function SendIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base strokeWidth={2.4} {...props}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </Base>
  );
}

export function WifiOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M1 1l22 22" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </Base>
  );
}
