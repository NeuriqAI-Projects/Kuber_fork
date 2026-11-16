import { isLeadOwner } from "@/lib/auth/scopes";
import { profileMember, type Profile } from "@/lib/api-client";

/**
 * Active members who receive leads (the "assign to" pickers). Rows come from
 * /api/v1/settings/users. Was `role === "employee" && is_active`.
 */
export function activeLeadOwners(users: Profile[]): Profile[] {
  return users.filter((u) => u.is_active && isLeadOwner(profileMember(u)));
}
