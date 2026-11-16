"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadMemberAccess } from "@/lib/server/session";

export type LoginState = { error?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return { error: error.message };

  // "Has access" is an active profile with a company — not a JWT claim. Auth
  // succeeding doesn't mean the profile is still active (e.g. the account was
  // deactivated after their last token expired) — block the login.
  if (!await loadMemberAccess(data.user.id)) {
    await supabase.auth.signOut();
    return { error: "This account has no access or has been turned off. Contact your admin." };
  }

  redirect("/dashboard");
}
