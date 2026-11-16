// Shared helpers for the scopes E2E run. Secrets are read from .env.local at runtime only, never printed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
export const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const DEV = "00000000-0000-0000-0000-00000000000a";
export const OWNER_EMAIL = "lakshit@gmail.com";
export const BASE = process.env.E2E_BASE || "http://localhost:3000";
export const SHOTS = join(tmpdir(), "kuber-scopes-e2e-shots");
export const STATE = join(tmpdir(), "kuber-scopes-e2e-state.json");

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const admin = () => createClient(SUPA_URL, SERVICE, opts);
export const anon = () => createClient(SUPA_URL, ANON, opts);

export const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null);
export const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

export async function tokenFor(email, password) {
  const { data, error } = await anon().auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return data.session.access_token;
}

/** Owner session without touching his password: magic link → verifyOtp. */
export async function ownerToken() {
  const { data, error } = await admin().auth.admin.generateLink({ type: "magiclink", email: OWNER_EMAIL });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const v = await anon().auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
  if (v.error) throw new Error(`verifyOtp: ${v.error.message}`);
  return v.data.session.access_token;
}

/** fetch → { status, body } (body parsed JSON or text). */
export async function api(token, method, path, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed };
}
export const msg = (r) => r.body?.error?.message;
export const need = (scope) => `You need the ${scope} permission for this. Ask the owner to add it.`;
