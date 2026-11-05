import { ok } from "@/lib/api-response";
import { LOCATION_MAP, COUNTRY_TIMEZONE } from "@/lib/constants";

export const maxDuration = 60;

export async function GET() {
  const locations = Object.entries(LOCATION_MAP).map(([label, apolloValue]) => ({
    label,
    apollo_value: apolloValue,
    timezone: COUNTRY_TIMEZONE[apolloValue] ?? null,
  }));

  return ok({ locations });
}
