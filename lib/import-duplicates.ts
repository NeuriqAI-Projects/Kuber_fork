export type OwnerCount = { assigned_to: string | null; count: number };

/**
 * Who owns an already-existing lead is other people's data, so a member
 * without leads:all gets owners collapsed to "self" / "other" / null
 * (unassigned). The counts stay, so the import screen can still say
 * "36 assigned to another team member, contact your manager".
 */
export function hideOwners(counts: OwnerCount[], selfId: string): OwnerCount[] {
  const merged = new Map<string | null, number>();
  for (const c of counts) {
    const key = c.assigned_to === null ? null : c.assigned_to === selfId ? "self" : "other";
    merged.set(key, (merged.get(key) ?? 0) + c.count);
  }
  return [...merged].map(([assigned_to, count]) => ({ assigned_to, count }));
}
