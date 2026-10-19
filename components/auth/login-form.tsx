"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { loginAction, type LoginState } from "@/lib/auth/login-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_LOGO_INITIAL, APP_NAME, APP_TAGLINE } from "@/lib/branding";

export function LoginForm() {
  const [state, formAction, isPending] = useActionState<LoginState, FormData>(
    loginAction,
    {},
  );
  const [showPwd, setShowPwd] = useState(false);
  // Controlled so a failed sign-in does not wipe the fields (server actions
  // reset uncontrolled inputs when the action returns).
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar p-4">
      <div className="w-full max-w-[360px] rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-col items-center px-6 pt-8 pb-2 text-center">
          <div className="mb-5 flex size-10 items-center justify-center rounded-lg bg-foreground shadow-sm">
            <span className="text-base font-bold text-background">{APP_LOGO_INITIAL}</span>
          </div>
          <h1 className="text-lg font-semibold leading-tight">Sign in to {APP_NAME}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{APP_TAGLINE}</p>
        </div>
        <form action={formAction} className="space-y-3.5 px-6 pt-4 pb-6">
          <div className="space-y-1.5">
            <Label
              htmlFor="email"
              className="text-[13px] font-medium"
            >
              Email
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              disabled={isPending}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="password"
              className="text-[13px] font-medium"
            >
              Password
            </Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPwd ? "text" : "password"}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="pr-10"
                disabled={isPending}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={showPwd ? "Hide password" : "Show password"}
                disabled={isPending}
                suppressHydrationWarning
              >
                {showPwd ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </div>
          {state.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300">{state.error}</p>
          )}
          <Button type="submit" disabled={isPending} className="mt-1 w-full" suppressHydrationWarning>
            {isPending ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
