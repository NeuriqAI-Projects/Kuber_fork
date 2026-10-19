import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Keep visited pages in the client router cache so going back to a screen
    // (Dashboard → Leads → Dashboard) reuses it instead of a new server round
    // trip. Next 15's default for dynamic pages is 0 (never reused). Data on
    // those screens still refreshes in the background via lib/api-client's cache.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
