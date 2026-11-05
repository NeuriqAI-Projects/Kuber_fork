import { fail } from "@/lib/api-response";

export const maxDuration = 60;

/**
 * @deprecated — This endpoint is superseded by POST /api/v1/campaigns/{id}/generate-drafts.
 * That endpoint calls lib/services/generate-drafts.ts → generateOneDraft() which has
 * the correct signature + attachment + placeholder-scrubbing logic.
 * Returns 410 Gone to prevent accidental use.
 */
export async function POST() {
  return fail(
    410,
    "DEPRECATED",
    "This endpoint is deprecated. Use POST /api/v1/campaigns/{id}/generate-drafts instead.",
  );
}
