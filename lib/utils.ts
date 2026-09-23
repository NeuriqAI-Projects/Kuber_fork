import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
