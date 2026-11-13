import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** No mouse / key / scroll / touch input for this long = nobody is looking. */
export const IDLE_MS = 5 * 60_000;
let lastInput = Date.now();
let tracking = false;
const wakers = new Set<() => void>();

/** One shared idle tracker for every poll (installed on first use). Input after
 *  an idle spell, or the tab being shown, wakes the polls that skipped ticks. */
function trackInput() {
  if (tracking) return;
  tracking = true;
  const touch = () => {
    const wasIdle = Date.now() - lastInput > IDLE_MS;
    lastInput = Date.now();
    if (wasIdle) wakers.forEach((f) => f());
  };
  for (const e of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(e, touch, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") touch(); });
}

/** True when nobody touched the page for `IDLE_MS`. */
export function userIdle(): boolean {
  return Date.now() - lastInput > IDLE_MS;
}

/** setInterval for browser polls: skips ticks while the tab is hidden or nobody
 *  has touched it for 5 min, and runs once at once when the tab is shown again or
 *  the user comes back (if a tick was missed). Each tick is a Vercel call, and a
 *  tab left open on a second screen used to poll all day. Returns the stop function. */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  trackInput();
  let last = Date.now();
  const live = () => document.visibilityState === "visible" && !userIdle();
  const run = () => { last = Date.now(); fn(); };
  const t = setInterval(() => { if (live()) run(); }, ms);
  const wake = () => { if (live() && Date.now() - last >= ms) run(); };
  document.addEventListener("visibilitychange", wake);
  wakers.add(wake);
  return () => { clearInterval(t); document.removeEventListener("visibilitychange", wake); wakers.delete(wake); };
}

/** USD, with cents for anything under $1 (AI cost is often a few tenths of a
 *  cent per call) and whole dollars once the amount is large enough that the
 *  cents stop being informative. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  const decimals = Math.abs(amount) < 1 ? 4 : Math.abs(amount) < 100 ? 2 : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/** English ordinal suffix: 1 → "1st", 2 → "2nd", 11 → "11th", etc. */
export function formatOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}
