// The Kuber AI mark: a "K" whose top arm launches a spark, on a deep indigo tile.
//
// Fixed colours on purpose — it is a product mark, so it looks the same whichever
// theme colour a company picks (the app's primary only tints UI). The same drawing
// ships as public/brand/kuber-ai-mark.svg (+ a 512px PNG) for use outside the app.
import { useId } from "react";
import { cn } from "@/lib/utils";

export function KuberAiMark({ className, title }: { className?: string; title?: string }) {
  // Several marks render on one page (sidebar, launcher, panel), so gradient ids must be unique.
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 48 48"
      className={cn("shrink-0", className)}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}t`} x1="6" y1="2" x2="44" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="0.55" stopColor="#3730a3" />
          <stop offset="1" stopColor="#1e1b4b" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx="35" cy="12" r="16" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#60a5fa" stopOpacity="0.75" />
          <stop offset="1" stopColor="#60a5fa" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}s`} x1="24" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}p`} x1="29" y1="6" x2="40" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c7d2fe" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill={`url(#${id}t)`} />
      <rect width="48" height="48" rx="13" fill={`url(#${id}g)`} />
      <rect x="0.5" y="0.5" width="47" height="23.5" rx="12.5" fill={`url(#${id}s)`} />
      <rect x="0.75" y="0.75" width="46.5" height="46.5" rx="12.25" fill="none" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="1.5" />
      <g stroke="#ffffff" strokeWidth="4.6" strokeLinecap="round" fill="none">
        <line x1="15.5" y1="14" x2="15.5" y2="34" />
        <line x1="18.4" y1="25.4" x2="26.4" y2="17.4" />
        <line x1="20.6" y1="23.6" x2="30.5" y2="34" />
      </g>
      <path
        d="M34.5 6.6 C35.1 10.4 36.6 11.9 40.4 12.5 C36.6 13.1 35.1 14.6 34.5 18.4 C33.9 14.6 32.4 13.1 28.6 12.5 C32.4 11.9 33.9 10.4 34.5 6.6 Z"
        fill={`url(#${id}p)`}
      />
      <circle cx="39.6" cy="19.4" r="1.35" fill="#a5b4fc" />
    </svg>
  );
}
