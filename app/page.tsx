import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { createClient } from "@/lib/supabase/server";
import { loadMemberAccess } from "@/lib/server/session";

export default async function LoginPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user && await loadMemberAccess(user.id)) {
    redirect("/dashboard");
  }

  return <LoginForm />;
}
