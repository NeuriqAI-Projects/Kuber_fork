import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Keep visited pages in the client router cache so going back to a screen
    // (Dashboard → Leads → Dashboard) reuses it instead of a new server round
    // trip. Next 15's default for dynamic pages is 0 (never reused).
    //
    // 5 minutes is safe because no (app) page renders server data any more:
    // every screen is a client shell that loads and refreshes its data through
    // lib/api-client's cache, so a cached RSC payload can't show stale rows.
    // (The (app) layout's lead total isn't refetched on soft navigation anyway.)
    staleTimes: {
      dynamic: 300,
      static: 300,
    },
  },
};

export default nextConfig;
