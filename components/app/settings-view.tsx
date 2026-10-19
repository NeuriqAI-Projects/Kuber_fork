"use client";

import type React from "react";
import { toast } from "sonner";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  User, Bot, LogOut, Plus,
  PenLine, Type, Palette, Check, Sun, Moon,
  Building2, Package, FileText, X, Lock, Tags, Pencil, Loader2,
  KeyRound, Users, Mail, Code2, Reply, Settings as SettingsIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { AvailabilityToggle } from "@/components/ui/availability-toggle";
import { LEAD_TEMPLATE_VARS } from "@/components/ui/template-var-textarea";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
// Aliased: this file also declares its own local RichTextEditor further down
// (a plain-text-output contentEditable wrapper, correct for prompt fields fed
// to an LLM). followup_fallback_body is genuinely HTML — campaign-fanout.ts's
// renderFollowupFallback assigns it straight to an Instantly custom variable
// with no newline-to-<br> conversion — so it needs the real, HTML-output
// shared editor instead, or a manager's line breaks silently vanish in the
// sent email.
import type { TemplateVar } from "@/components/ui/rich-text-editor";
import { queryCache, fetchLogo, fetchSettings, patchSettings, fetchMySettings, patchMySettings, removeLogo, uploadLogo, fetchMyAvailability, setMyAvailability, type AvailabilityStatus } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { BRAND_LOGO_CHANGED, COLORS } from "@/lib/branding";
import { MANDATORY_FORMATTING_RULES, parseIndustryKeywordGroups, type IndustryKeywordGroup } from "@/lib/constants";
import { useTheme } from "@/lib/theme-context";
import { useApp } from "@/lib/app-context";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";

const TeamView = dynamic(
  () => import("@/components/app/team-view").then((m) => m.TeamView),
  { ssr: false, loading: () => <div className="animate-pulse"><div className="h-40 rounded-lg bg-secondary" /></div> },
);

// tiptap: only the follow-up fallback / HTML sections use it — load on demand.
const HtmlRichTextEditor = dynamic(
  () => import("@/components/ui/rich-text-editor").then((m) => m.RichTextEditor),
  { ssr: false, loading: () => <div className="min-h-[160px]" aria-busy="true" /> },
);

const EmailSendingView = dynamic(
  () => import("@/components/app/email-sending-view").then((m) => m.EmailSendingView),
  { ssr: false, loading: () => <div className="animate-pulse"><div className="h-40 rounded-lg bg-secondary" /></div> },
);

type Section = "profile" | "ai" | "knowledge" | "appearance" | "account" | "team" | "email";
type AiSection = "my-writing" | "my-signature" | "template" | "default" | "followup" | "html" | "replies" | "footer";
type KnowledgeSection = "company" | "products" | "industry-segments";
type ProductOffering = { name: string; description: string };

// Only first_name — lib/services/settings.ts's renderFollowupFallback (the
// function that actually fills this field at send time) supports nothing
// else. LEAD_TEMPLATE_VARS' extra company/last_name pills would look right
// here but ship as literal "{{...}}" text.
const FOLLOWUP_FALLBACK_TEMPLATE_VARS: TemplateVar[] = [
  { token: "first_name", label: "first_name", description: "Lead's first name", example: "John" },
];

// Knowledge Sources is open to everyone — employees work with the company
// context and product library more than managers do. Prompt-shaped company
// defaults (Email Template, Reply AI, Footer) remain manager-only.
const NAV_ITEMS: { id: Section; label: string }[] = [
  { id: "profile",    label: "My profile" },
  { id: "ai",         label: "AI & outreach" },
  { id: "knowledge",  label: "Knowledge sources" },
  { id: "appearance", label: "Appearance" },
  { id: "account",    label: "Account" },
];

const MANAGER_NAV_ITEMS: { id: Section; label: string }[] = [
  { id: "profile",    label: "My profile" },
  { id: "ai",         label: "AI & outreach" },
  { id: "knowledge",  label: "Knowledge sources" },
  { id: "appearance", label: "Appearance" },
  { id: "account",    label: "Account" },
  { id: "team",       label: "Team" },
];

// Personal tabs (everyone — stored per user, campaigns you create use these) vs
// company-default tabs (managers only — the fallback every user inherits).
const PERSONAL_AI_NAV_ITEMS: { id: AiSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "my-writing",   label: "My writing",   icon: PenLine },
  { id: "my-signature", label: "My signature", icon: Type },
];

const COMPANY_AI_NAV_ITEMS: { id: AiSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "template", label: "Email template",  icon: PenLine },
  { id: "default",  label: "Default draft",   icon: FileText },
  { id: "followup", label: "Follow-up fallback", icon: Reply },
  { id: "html",     label: "HTML emails",     icon: Code2 },
  { id: "replies",  label: "Reply AI",        icon: Bot },
  { id: "footer",   label: "Email footer",    icon: Type },
];

const KNOWLEDGE_NAV_ITEMS: { id: KnowledgeSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "company",   label: "Company details",   icon: Building2 },
  { id: "products",  label: "Product offerings", icon: Package },
  { id: "industry-segments", label: "Industry segments", icon: Tags },
];

// The prompt editor moved to components/ui/prompt-editor.tsx when Model Lab
// needed the same control — one shared component per control type (CLAUDE.md).
// Aliased to RichTextEditor so the ~15 call sites below read unchanged.
import { PromptEditor as RichTextEditor } from "@/components/ui/prompt-editor";

// A single settings field laid out as label+description on the left and the
// actual control on the right, instead of label-above-control stacked in one
// column. Used throughout Profile / Knowledge Sources / Appearance / Account
// for compact fields; large canvases (rich-text prompts, textareas) stay
// full-width below their own header since cramming them into a narrow right
// column would hurt usability.
function SettingsRow({
  label, description, children, htmlFor,
}: {
  label: string; description?: React.ReactNode; children: React.ReactNode; htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 py-4 border-b border-border last:border-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-8">
      <div>
        <Label htmlFor={htmlFor} className="text-[13px] font-medium text-foreground">{label}</Label>
        {description && <p className="text-[13px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// Attio settings section header: title + muted description, a 1px rule under
// it, optional tag/action on the right.
function SectionHeader({
  title, description, aside, info,
}: {
  title: string; description?: React.ReactNode; aside?: React.ReactNode; info?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
          {info && <InfoTooltip text={info} />}
        </div>
        {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

// "Personal" vs "Using company default" tag next to a personal prompt.
function OverrideTag({ personal }: { personal: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-[5px] px-1.5 py-[3px] text-xs font-medium leading-none whitespace-nowrap",
      personal ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
    )}>
      {personal ? "Personal" : "Using company default"}
    </span>
  );
}

function InheritedDefault({ text, maxH = "max-h-64" }: { text: string; maxH?: string }) {
  return (
    <details className="rounded-md border border-border bg-secondary p-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium text-foreground">View the company default you&apos;re inheriting</summary>
      <pre className={cn("mt-2 overflow-y-auto whitespace-pre-wrap font-sans", maxH)}>{text}</pre>
    </details>
  );
}

// A personal drafting/reply prompt fully REPLACES the company default, so it
// looks like it controls everything the AI writes. It doesn't — a small set of
// formatting rules (bold key facts, use bullet pointers) is always appended in
// code after whichever prompt is in effect, so it survives no matter what
// someone writes above. Surfaced here so that isn't a surprise, and someone
// writing their own prompt knows not to duplicate it.
function MandatoryFormattingNotice() {
  const bullets = MANDATORY_FORMATTING_RULES
    .split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .map((line) => line.trim().slice(2));
  return (
    <div className="rounded-md border border-border bg-secondary p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Lock className="size-3.5 text-muted-foreground" />
        Always applied on top of the prompt above
      </div>
      <ul className="space-y-1 pl-1 text-xs text-muted-foreground">
        {bullets.map((bullet, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-muted-foreground">•</span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Self-service availability toggle (spec §2B) — an employee marking themselves
// available/away (e.g. going on leave) so they stop receiving new automatic
// assignments, without being deactivated. Self-contained (own fetch/save).
function AvailabilityCard() {
  const [status, setStatus] = useState<AvailabilityStatus | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? "";
        const res = await fetchMyAvailability(token);
        setStatus(res.availability_status);
      } catch { /* leave null */ }
    })();
  }, []);

  async function toggle() {
    if (saving || !status) return;
    const next: AvailabilityStatus = status === "online" ? "offline" : "online";
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const res = await setMyAvailability(token, next);
      setStatus(res.availability_status);
      toast.success(res.availability_status === "offline" ? "You're now marked as away" : "You're now available");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="py-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium flex items-center gap-2">
          Availability
          {status && (
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                status === "online" ? "bg-emerald-500" : "bg-amber-500",
              )}
              aria-hidden
            />
          )}
        </p>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          {status === "offline"
            ? "You're marked away — you won't receive new automatic lead assignments (you can still be assigned manually)."
            : "You're available for new automatic lead assignments."}
        </p>
      </div>
      <AvailabilityToggle
        status={status}
        disabled={saving}
        onToggle={() => void toggle()}
      />
    </div>
  );
}

export function SettingsView() {
  const { theme, mode, setTheme, setMode, savingTheme } = useTheme();
  const { role } = useApp();
  const isManager = role === "manager";
  // Declared here (rather than alongside the other useState calls below) so
  // navItems — which needs it — can be computed in the same statement order
  // hooks already run in; moving a useState call is safe as long as it still
  // runs unconditionally on every render.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const navItems = isManager
    ? [...MANAGER_NAV_ITEMS, { id: "email" as const, label: "Email & sending" }]
    : NAV_ITEMS;
  const aiNavItems = isManager ? [...PERSONAL_AI_NAV_ITEMS, ...COMPANY_AI_NAV_ITEMS] : PERSONAL_AI_NAV_ITEMS;
  // Company Details is company identity (sender name, context, logo) — manager /
  // super-admin only. Employees keep the Product Offerings library.
  const knowledgeNavItems = isManager ? KNOWLEDGE_NAV_ITEMS : KNOWLEDGE_NAV_ITEMS.filter((i) => i.id !== "company");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<Section>("profile");
  const [aiSection, setAiSection] = useState<AiSection>("my-writing");
  const [knowledgeSection, setKnowledgeSection] = useState<KnowledgeSection>("company");

  // Deep-link support, e.g. /settings?section=knowledge&knowledge=industry-segments
  // (used by the "Manage groups in Settings" link in the Apollo import dropdown)
  // so it lands directly on the tab it's pointing at rather than the default.
  const searchParams = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const s = searchParams.get("section");
    // Keys and Usage moved to their own Credits page; old links still land there.
    if (s === "keys") { router.replace("/credits"); return; }
    if (s === "knowledge" || s === "ai" || s === "appearance" || s === "account" || s === "team" || s === "email" || s === "profile") {
      setSection(s);
    }
    const k = searchParams.get("knowledge");
    if (k === "company" || k === "products" || k === "industry-segments") {
      setKnowledgeSection(k);
    }
  }, [searchParams]);

  // Company-wide settings (managers edit; everyone inherits)
  const [senderName,     setSenderName    ] = useState("");
  const [clientIndustry, setClientIndustry] = useState("");
  const [companyContext, setCompanyContext] = useState("");
  const [systemPrompt,   setSystemPrompt  ] = useState("");
  const [genericSubject, setGenericSubject] = useState("");
  const [genericBody,    setGenericBody   ] = useState("");
  const [followupFallbackBody, setFollowupFallbackBody] = useState("");
  const [allowHtmlEmails, setAllowHtmlEmails] = useState(false);
  const [logoPath,       setLogoPath      ] = useState<string | null>(null);
  const [logoUrl,        setLogoUrl       ] = useState<string | null>(null);
  const [logoUploading,  setLogoUploading ] = useState(false);

  const [sigContact, setSigContact] = useState("");

  const [productOfferings, setProductOfferings] = useState<ProductOffering[]>([]);
  const [industryKeywordGroups, setIndustryKeywordGroups] = useState<IndustryKeywordGroup[]>([]);
  // Each group card renders as plain text by default; its single pencil icon
  // opens the whole card (group name + every keyword + "Add keyword") into
  // edit mode at once, rather than every field being a live text box always.
  const [editingGroupIds, setEditingGroupIds] = useState<Set<string>>(new Set());
  // Which group cards currently have an add/remove/rename request in flight —
  // drives the small loading state on that card's pencil/checkmark button.
  const [savingGroupIds, setSavingGroupIds] = useState<Set<string>>(new Set());
  // Deleting a whole group (and every keyword in it) is a much bigger action
  // than removing one keyword, and its "X" sits right next to the pencil in
  // a small header — a real misclick took out a whole group with no warning
  // during testing. Confirm before it actually happens.
  const [groupPendingDelete, setGroupPendingDelete] = useState<{ idx: number; label: string } | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);

  const [replyDrafterPrompt,    setReplyDrafterPrompt   ] = useState("");

  // Personal settings (per user — campaigns you create use these; empty = inherit)
  const [myDraftPrompt, setMyDraftPrompt] = useState("");
  const [myDraftTemplate, setMyDraftTemplate] = useState("");
  const [myReplyPrompt, setMyReplyPrompt] = useState("");
  const [mySignature,   setMySignature  ] = useState("");
  const [mySenderName,  setMySenderName ] = useState("");
  const [myDefaults,    setMyDefaults   ] = useState({ draft_prompt: "", reply_prompt: "", signature: "", sender_name: "" });

  const [userEmail, setUserEmail] = useState("");
  const [userName,  setUserName  ] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving,  setSaving  ] = useState(false);
  const [error,   setError   ] = useState("");

  const activeAiNavItem        = aiNavItems.find((i) => i.id === aiSection);
  // Employees can't see "company" (manager-only identity settings), but can
  // freely switch between the other Knowledge Sources tabs — only fall back
  // to "products" if they land on the one tab hidden from them.
  const activeKnowledgeSection: KnowledgeSection = (!isManager && knowledgeSection === "company") ? "products" : knowledgeSection;
  const activeKnowledgeNavItem = KNOWLEDGE_NAV_ITEMS.find((i) => i.id === activeKnowledgeSection);

  // One Attio-style settings nav: every leaf (including the AI and Knowledge
  // sub-tabs, which used to be a second sidebar) sits in a labelled group.
  type NavEntry = { key: string; label: string; icon: LucideIcon | React.ComponentType<{ className?: string }>; section: Section; ai?: AiSection; knowledge?: KnowledgeSection };
  const SECTION_ICONS: Record<Section, LucideIcon> = {
    profile: User, ai: PenLine, knowledge: Building2, appearance: Palette, account: KeyRound, team: Users, email: Mail,
  };
  const sectionEntry = (id: Section): NavEntry | null => {
    const item = navItems.find((n) => n.id === id);
    return item ? { key: id, label: item.label, icon: SECTION_ICONS[id], section: id } : null;
  };
  const navGroups: { label: string; items: NavEntry[] }[] = [
    { label: "Personal", items: [sectionEntry("profile"), sectionEntry("appearance"), sectionEntry("account")].filter((e): e is NavEntry => !!e) },
    { label: "AI & outreach", items: PERSONAL_AI_NAV_ITEMS.map((i) => ({ key: `ai-${i.id}`, label: i.label, icon: i.icon, section: "ai" as const, ai: i.id })) },
    ...(isManager
      ? [{ label: "Company defaults", items: COMPANY_AI_NAV_ITEMS.map((i) => ({ key: `ai-${i.id}`, label: i.label, icon: i.icon, section: "ai" as const, ai: i.id })) }]
      : []),
    { label: "Knowledge sources", items: knowledgeNavItems.map((i) => ({ key: `kn-${i.id}`, label: i.label, icon: i.icon, section: "knowledge" as const, knowledge: i.id })) },
    ...(isManager
      ? [{ label: "Workspace", items: [sectionEntry("team"), sectionEntry("email")].filter((e): e is NavEntry => !!e) }]
      : []),
  ];
  const isActiveEntry = (e: NavEntry) =>
    e.section === section &&
    (!e.ai || e.ai === aiSection) &&
    (!e.knowledge || e.knowledge === activeKnowledgeSection);
  const openEntry = (e: NavEntry) => {
    setSection(e.section);
    if (e.ai) setAiSection(e.ai);
    if (e.knowledge) setKnowledgeSection(e.knowledge);
  };

  // The breadcrumb shows the ancestor trail; the deepest active item becomes the page title.
  const sectionLabel = navItems.find((n) => n.id === section)?.label ?? "Settings";
  const pageTitle =
    (section === "ai" && activeAiNavItem?.label) ||
    (section === "knowledge" && activeKnowledgeNavItem?.label) ||
    sectionLabel;
  const activeGroupLabel = navGroups.find((g) => g.items.some(isActiveEntry))?.label;

  // Layout effect: the cached copy is applied before the first paint, so a
  // revisit never flashes the skeleton for a frame.
  useLayoutEffect(() => {
    // Settings forms paint from the last loaded copy on a revisit (no
    // skeleton). The fresh copy is applied only when it actually differs from
    // what was shown, so a background refresh can't overwrite a field the user
    // started typing into unless the data really changed on the server.
    type MyData = Awaited<ReturnType<typeof fetchMySettings>>;
    type CompanyData = Awaited<ReturnType<typeof fetchSettings>>;
    type LogoData = { logo_path: string | null; logo_url: string | null };
    const MY_KEY = "/api/v1/me/settings";
    const SETTINGS_KEY = "/api/v1/settings";
    const LOGO_KEY = "/api/v1/settings/logo";

    function applyMy(my: MyData) {
      // Keys nav depends on this — set it from /me/settings immediately so we
      // don't wait on company settings / logo (or a full Team users list).
      setIsSuperAdmin(my.is_super_admin);
      setMyDraftPrompt(my.draft_prompt ?? "");
      setMyDraftTemplate(my.draft_template ?? "");
      setMyReplyPrompt(my.reply_prompt ?? "");
      setMySignature(my.signature ?? "");
      setMySenderName(my.sender_name ?? "");
      setMyDefaults(my.defaults);
    }
    function applySettings(s: CompanyData) {
      if (!s) return;
      setSenderName(s.default_sender_name ?? "");
      setClientIndustry(s.client_industry ?? "");
      setCompanyContext(s.company_context ?? "");
      setSystemPrompt(s.system_prompt ?? "");
      setGenericSubject(s.generic_email_subject ?? "");
      setGenericBody(s.generic_email_body ?? "");
      setFollowupFallbackBody(s.followup_fallback_body ?? "");
      setAllowHtmlEmails(s.allow_html_emails === "true");
      setSigContact(s.signature_contact ?? "");
      setReplyDrafterPrompt(s.reply_drafter_prompt ?? "");
      try { setProductOfferings(JSON.parse(s.product_offerings ?? "[]") as ProductOffering[]); } catch { setProductOfferings([]); }
      setIndustryKeywordGroups(parseIndustryKeywordGroups(s.industry_keyword_groups));
    }
    function applyLogo(l: LogoData) {
      setLogoPath(l.logo_path);
      setLogoUrl(l.logo_url);
    }
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    const cachedMy = queryCache.getData<MyData>(MY_KEY);
    const cachedSettings = queryCache.getData<CompanyData>(SETTINGS_KEY);
    const cachedLogo = queryCache.getData<LogoData>(LOGO_KEY);
    // After a save anywhere (entries marked stale) wait for the server copy
    // instead of flashing the pre-save values.
    const notStale = (k: string) => queryCache.get(k)?.stale === false;
    const hasCache = cachedMy !== undefined && cachedSettings !== undefined && notStale(MY_KEY) && notStale(SETTINGS_KEY);
    if (hasCache) {
      applyMy(cachedMy);
      applySettings(cachedSettings);
      if (cachedLogo) applyLogo(cachedLogo);
    }

    async function load() {
      setLoading(!hasCache);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? "";
        setUserEmail(session?.user?.email ?? "");
        setUserName(session?.user?.user_metadata?.full_name ?? session?.user?.user_metadata?.name ?? "");

        // Personal settings, company settings and the logo all load for everyone
        // — employees need the company settings behind Knowledge Sources, and
        // GET /settings is readable by any authenticated user.
        const myPromise = queryCache.fetch(MY_KEY, () => fetchMySettings(token));
        const settingsPromise = queryCache.fetch(SETTINGS_KEY, () => fetchSettings(token));
        const logoPromise = queryCache.fetch(LOGO_KEY, () => fetchLogo(token)).catch(() => ({ logo_path: null, logo_url: null }));

        const my = await myPromise;
        if (!hasCache || !same(my, cachedMy)) applyMy(my);

        const s = await settingsPromise;
        if (!hasCache || !same(s, cachedSettings)) applySettings(s);
        setLoading(false);

        const l = await logoPromise;
        if (!cachedLogo || !same(l, cachedLogo)) applyLogo(l);
      } catch (e) {
        setError((e as Error).message);
        setLoading(false);
      }
    }
    void load();
  }, []);

  async function handleLogoPick(file: File | null) {
    if (!file) return;
    setLogoUploading(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const res = await uploadLogo(token, file);
      setLogoPath(res.logo_path);
      setLogoUrl(res.logo_url);
      // The upload route already wrote brand_logo_path; re-patching it here was
      // a redundant round trip. Tell the app shell instead — it renders the
      // sidebar logo and otherwise wouldn't notice until a full page reload.
      window.dispatchEvent(new CustomEvent(BRAND_LOGO_CHANGED, { detail: res.logo_url }));
      toast.success("Logo updated");
    } catch (e) { setError((e as Error).message); toast.error((e as Error).message); }
    finally { setLogoUploading(false); }
  }

  async function handleLogoRemove() {
    setLogoUploading(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      await removeLogo(token);
      setLogoPath(null);
      setLogoUrl(null);
      window.dispatchEvent(new CustomEvent(BRAND_LOGO_CHANGED, { detail: null }));
      toast.success("Logo removed");
    } catch (e) { setError((e as Error).message); toast.error((e as Error).message); }
    finally { setLogoUploading(false); }
  }

  const onPersonalTab = section === "ai" && (aiSection === "my-writing" || aiSection === "my-signature");

  async function handleSave() {
    // Only validate Product Offerings completeness when the user is actually on that
    // tab. Without this scoping, a stale incomplete product sitting in Knowledge
    // Sources blocks saving on completely unrelated tabs (Email Template, Reply AI,
    // Email Footer) even when nothing about products was touched — confirmed live bug.
    if (section === "knowledge" && activeKnowledgeSection === "products") {
      const incompleteProduct = productOfferings.find(
        (p) => !p.name.trim() || !p.description.trim()
      );
      if (incompleteProduct) {
        toast.error("Every product needs both a name and a description before saving.");
        return;
      }
    }

    setSaving(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";

      if (onPersonalTab) {
        // Personal settings — empty fields clear back to "inherit company default".
        const my = await patchMySettings(token, {
          draft_prompt: myDraftPrompt.trim() || null,
          draft_template: myDraftTemplate.trim() || null,
          reply_prompt: myReplyPrompt.trim() || null,
          signature:    mySignature.trim() || null,
          sender_name:  mySenderName.trim() || null,
        });
        setMyDefaults(my.defaults);
        toast.success("Your settings were saved");
      } else if (section === "knowledge") {
        // Send only the keys these tabs own — the prompt-shaped keys are
        // manager-only server-side and including them would 403 the save.
        // Company Details is manager-only too, so an employee sends products
        // alone; sending those keys back unchanged would 403 their whole save.
        await patchSettings(token, {
          product_offerings: JSON.stringify(productOfferings),
          ...(isManager && {
            default_sender_name: senderName,
            client_industry:     clientIndustry,
            company_context:     companyContext,
          }),
        });
        toast.success("Knowledge sources saved");
      } else {
        await patchSettings(token, {
          system_prompt:           systemPrompt,
          generic_email_subject:   genericSubject,
          generic_email_body:      genericBody,
          followup_fallback_body:  followupFallbackBody,
          allow_html_emails:       allowHtmlEmails ? "true" : "false",
          signature_contact:       sigContact,
          reply_drafter_prompt:    replyDrafterPrompt,
        });
        toast.success("Company settings saved");
      }
    } catch (e) {
      toast.error((e as Error).message);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateProduct(idx: number, field: keyof ProductOffering, value: string) {
    setProductOfferings((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }

  function removeProduct(idx: number) {
    setProductOfferings((prev) => prev.filter((_, i) => i !== idx));
  }

  function addProduct() {
    setProductOfferings((prev) => [...prev, { name: "", description: "" }]);
  }

  // Every structural change (add/remove group, add/remove keyword, and a
  // rename finished via the card's "done" checkmark) saves straight to
  // Supabase on its own — it does NOT wait for the page's "Save" button.
  // That button re-sending the whole locally-held list caused a real data-loss
  // bug: an earlier accidental edit sitting unsaved in this section got baked
  // in permanently the next time someone hit Save for something unrelated
  // (e.g. Product Offerings). Saving each action immediately, against the
  // current server value, closes that gap.
  async function saveIndustryKeywordGroups(next: IndustryKeywordGroup[]) {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? "";
    await patchSettings(token, { industry_keyword_groups: JSON.stringify(next) });
  }

  async function addGroup() {
    const id = crypto.randomUUID();
    const previous = industryKeywordGroups;
    const next = [...previous, { id, label: "", emoji: "🏷️", keywords: [] }];
    setIndustryKeywordGroups(next);
    setEditingGroupIds((prev) => new Set(prev).add(id));
    setSavingGroupIds((prev) => new Set(prev).add(id));
    try {
      await saveIndustryKeywordGroups(next);
    } catch {
      setIndustryKeywordGroups(previous);
      setEditingGroupIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      toast.error("Couldn't create the group — please try again.");
    } finally {
      setSavingGroupIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  function updateGroup(groupIdx: number, label: string) {
    setIndustryKeywordGroups((prev) => prev.map((g, i) => i === groupIdx ? { ...g, label } : g));
  }

  async function removeGroup(groupIdx: number) {
    const previous = industryKeywordGroups;
    const removedId = previous[groupIdx]?.id;
    const next = previous.filter((_, i) => i !== groupIdx);
    setIndustryKeywordGroups(next);
    if (removedId) setSavingGroupIds((prev) => new Set(prev).add(removedId));
    try {
      await saveIndustryKeywordGroups(next);
    } catch {
      setIndustryKeywordGroups(previous);
      toast.error("Couldn't delete the group — please try again.");
    } finally {
      if (removedId) setSavingGroupIds((prev) => { const s = new Set(prev); s.delete(removedId); return s; });
    }
  }

  async function confirmRemoveGroup() {
    if (!groupPendingDelete) return;
    setDeletingGroup(true);
    await removeGroup(groupPendingDelete.idx);
    setDeletingGroup(false);
    setGroupPendingDelete(null);
  }

  async function addKeyword(groupIdx: number) {
    const previous = industryKeywordGroups;
    const groupId = previous[groupIdx]?.id;
    const next = previous.map((g, i) =>
      i === groupIdx ? { ...g, keywords: [...g.keywords, { id: crypto.randomUUID(), label: "", query: "" }] } : g,
    );
    setIndustryKeywordGroups(next);
    if (groupId) setSavingGroupIds((prev) => new Set(prev).add(groupId));
    try {
      await saveIndustryKeywordGroups(next);
    } catch {
      setIndustryKeywordGroups(previous);
      toast.error("Couldn't add the keyword — please try again.");
    } finally {
      if (groupId) setSavingGroupIds((prev) => { const s = new Set(prev); s.delete(groupId); return s; });
    }
  }

  // The card's single pencil doubles as "done": closing edit mode is the save
  // point for whatever text was typed into the group name / keyword fields
  // while it was open. On failure, edit mode stays open (with the typed text
  // intact) so the user can just hit the checkmark again to retry.
  async function toggleGroupEdit(id: string) {
    if (!editingGroupIds.has(id)) {
      setEditingGroupIds((prev) => new Set(prev).add(id));
      return;
    }
    setSavingGroupIds((prev) => new Set(prev).add(id));
    try {
      await saveIndustryKeywordGroups(industryKeywordGroups);
      setEditingGroupIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } catch {
      toast.error("Couldn't save — please try again.");
    } finally {
      setSavingGroupIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  function updateKeyword(groupIdx: number, kwIdx: number, field: "label" | "query", value: string) {
    setIndustryKeywordGroups((prev) => prev.map((g, i) =>
      i === groupIdx ? { ...g, keywords: g.keywords.map((k, ki) => ki === kwIdx ? { ...k, [field]: value } : k) } : g,
    ));
  }

  async function removeKeyword(groupIdx: number, kwIdx: number) {
    const previous = industryKeywordGroups;
    const groupId = previous[groupIdx]?.id;
    const next = previous.map((g, i) =>
      i === groupIdx ? { ...g, keywords: g.keywords.filter((_, ki) => ki !== kwIdx) } : g,
    );
    setIndustryKeywordGroups(next);
    if (groupId) setSavingGroupIds((prev) => new Set(prev).add(groupId));
    try {
      await saveIndustryKeywordGroups(next);
    } catch {
      setIndustryKeywordGroups(previous);
      toast.error("Couldn't remove the keyword — please try again.");
    } finally {
      if (groupId) setSavingGroupIds((prev) => { const s = new Set(prev); s.delete(groupId); return s; });
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!userEmail) return;
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    setSavingPassword(true);
    try {
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: currentPassword,
      });
      if (reauthError) {
        toast.error("Current password is incorrect.");
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingPassword(false);
    }
  }

  const contentSkeleton = loading ? (
    <div className="mx-auto w-full max-w-3xl px-8 py-6 space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-5 w-32 bg-secondary rounded" />
        <div className="h-3 w-64 bg-secondary rounded" />
      </div>
      <div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-8 py-4 border-b border-border last:border-0">
            <div className="space-y-1.5 w-48">
              <div className="h-3.5 w-28 bg-secondary rounded" />
              <div className="h-3 w-full bg-secondary rounded" />
            </div>
            <div className="h-8 flex-1 max-w-sm bg-secondary rounded-md" />
          </div>
        ))}
      </div>
    </div>
  ) : null;

  // Industry Segments saves every action immediately (see saveIndustryKeywordGroups
  // above) — no page-wide Save button needed while that sub-tab is active.
  const showSaveBar = !loading && (section === "ai" || (section === "knowledge" && activeKnowledgeSection !== "industry-segments"));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        crumbs={[
          { label: "Settings", icon: <SettingsIcon /> },
          ...(activeGroupLabel ? [{ label: activeGroupLabel }] : []),
          { label: pageTitle },
        ]}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Settings nav */}
        <aside className="w-56 shrink-0 border-r border-border overflow-y-auto px-2 py-3">
          {navGroups.filter((g) => g.items.length > 0).map((group, gi) => (
            <div key={group.label} className={cn(gi > 0 && "mt-4")}>
              <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
              <div className="space-y-px">
                {group.items.map((entry) => {
                  const active = isActiveEntry(entry);
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => openEntry(entry)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium transition-colors",
                        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{entry.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>

        {/* Content */}
        <div className="relative flex-1 overflow-y-auto">
          {contentSkeleton}

          {!loading && (
            <div className={cn("mx-auto w-full px-8 py-6", section === "team" || section === "email" ? "max-w-5xl" : "max-w-3xl space-y-8")}>
              {section !== "team" && section !== "email" && (
                <h1 className="mb-6 text-lg font-semibold leading-tight">{pageTitle}</h1>
              )}

              {/* ── Profile ── */}
              {section === "profile" && (
                <div>
                  <div className="flex items-center gap-3 py-4 border-b border-border">
                    <div className="size-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
                      <User className="size-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm">{userName || "Admin"}</p>
                      <p className="text-[13px] text-muted-foreground truncate">{userEmail}</p>
                    </div>
                    <span className="shrink-0 rounded-[5px] bg-primary/10 px-1.5 py-[3px] text-xs font-medium leading-none text-primary">
                      {isSuperAdmin ? "Super Admin" : role === "manager" ? "Manager" : role === "employee" ? "Employee" : "—"}
                    </span>
                  </div>

                  <div>
                    <SettingsRow label="Display name" description="Managed through your Supabase auth account.">
                      <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Admin" disabled className="max-w-sm" />
                    </SettingsRow>
                    <SettingsRow label="Email address" description="Managed through your Supabase auth account.">
                      <Input value={userEmail} disabled className="max-w-sm" />
                    </SettingsRow>
                  </div>

                  {/* Employees can mark themselves away (spec §2B). */}
                  {role === "employee" && (
                    <div className="mt-6">
                      <SectionHeader title="Assignment" />
                      <AvailabilityCard />
                    </div>
                  )}
                </div>
              )}

              {/* ── AI & Outreach ── */}
              {section === "ai" && (
                <div className="space-y-10">
                  {aiSection === "my-writing" && (
                    <>
                      <section className="space-y-4">
                        <SectionHeader
                          title="My cold-email writing style"
                          description={<>Campaigns <strong>you create</strong> generate their emails with this prompt. Leave it empty to write with the company default — other people&apos;s campaigns are never affected by what you put here.</>}
                          aside={<OverrideTag personal={!!myDraftPrompt.trim()} />}
                        />
                        <RichTextEditor
                          label="My email template"
                          value={myDraftTemplate}
                          onChange={setMyDraftTemplate}
                          minHeight={260}
                          placeholder={"Paste the exact email you want sent, for example:\n\nI'm reaching out from Kuber Polyplast, an ISO 9001:2015 certified manufacturer with 30 years of experience...\n\nI came across (write about their company and what they make)\n\n- 18,000 MT annual production capacity\n- 6,670+ clients across 40+ countries\n\nPlease let us know if you have any current requirements."}
                          helper="Paste a finished email exactly as you want it sent. Every paragraph, bullet, number and closing line is reproduced as written; only the customer-specific parts change per lead. Put an instruction in round brackets — (write about their company and products) — wherever you want a sentence written about that specific customer; the bracket is replaced, never printed. Leave empty to use the drafting prompt below instead."
                        />

                        <RichTextEditor
                          label="My drafting prompt"
                          value={myDraftPrompt}
                          onChange={setMyDraftPrompt}
                          minHeight={320}
                          placeholder="Leave empty to use the company default, or write your own subject patterns, openings, offerings and tone here..."
                          helper="Company details, the product library and campaign context are appended automatically. Structure, length and tone come from this prompt, so anything you want changed you change here."
                        />
                        <MandatoryFormattingNotice />
                        {!myDraftPrompt.trim() && myDefaults.draft_prompt && <InheritedDefault text={myDefaults.draft_prompt} />}
                      </section>

                      <section className="space-y-4">
                        <SectionHeader
                          title="My reply writing style"
                          description={<>AI reply suggestions for <strong>your campaigns&apos;</strong> conversations follow this prompt. Empty = company default.</>}
                          aside={<OverrideTag personal={!!myReplyPrompt.trim()} />}
                        />
                        <RichTextEditor
                          label="My reply prompt"
                          value={myReplyPrompt}
                          onChange={setMyReplyPrompt}
                          minHeight={220}
                          placeholder="Leave empty to use the company default reply prompt..."
                          helper="Must return JSON with subject and body. Safety rules are appended automatically."
                        />
                        <MandatoryFormattingNotice />
                        {!myReplyPrompt.trim() && myDefaults.reply_prompt && <InheritedDefault text={myDefaults.reply_prompt} />}
                      </section>
                    </>
                  )}

                  {aiSection === "my-signature" && (
                    <>
                      <section className="space-y-4">
                        <SectionHeader
                          title="My signature"
                          description={<>Appended to every email of campaigns <strong>you create</strong> (cold emails and replies). A campaign&apos;s own signature override still wins. Empty = company footer.</>}
                          aside={<OverrideTag personal={!!mySignature.trim()} />}
                        />
                        <RichTextEditor
                          label="Sign-off block"
                          value={mySignature}
                          onChange={setMySignature}
                          minHeight={160}
                          singleLineBreaks
                          placeholder={"Your Name\nYour Title\nKuber Polyplast\n+91-XXXXXXXXXX"}
                        />
                        {!mySignature.trim() && myDefaults.signature && <InheritedDefault text={myDefaults.signature} maxH="max-h-40" />}
                      </section>

                      <section>
                        <SectionHeader title="My sender name" />
                        <SettingsRow
                          label="Sender name"
                          description={<>Pre-filled as the &quot;From&quot; name when you create a campaign. Empty = company default{myDefaults.sender_name ? ` (“${myDefaults.sender_name}”)` : ""}.</>}
                        >
                          <Input value={mySenderName} onChange={(e) => setMySenderName(e.target.value)} placeholder={myDefaults.sender_name || "Kuber Polyplast"} maxLength={200} className="max-w-sm" />
                        </SettingsRow>
                      </section>
                    </>
                  )}

                  {isManager && aiSection === "template" && (
                    <section className="space-y-4">
                      <SectionHeader
                        title="AI writing instructions"
                        description={<>The <strong>company default</strong> prompt for outreach emails — used by every campaign whose owner hasn&apos;t set a personal writing style. Put subject-line patterns, opening/closing options, offerings, key strengths, and tone here.</>}
                      />
                      <RichTextEditor
                        label="Base prompt"
                        value={systemPrompt}
                        onChange={setSystemPrompt}
                        minHeight={400}
                        placeholder="Write the full email template here including subject patterns, intro options, offerings, closing..."
                        helper="Campaign-level context and matched product details are appended automatically."
                      />
                      <MandatoryFormattingNotice />
                    </section>
                  )}

                  {isManager && aiSection === "default" && (
                    <section className="space-y-4">
                      <SectionHeader
                        title="Fallback email"
                        description="Sent as-is to leads with no company profile to personalise from."
                        info="Exact subject and body sent to unenriched / Input Required leads (no company profile to personalise). Enriched leads still use AI Writing Instructions. A greeting and signature are added automatically."
                      />
                      <SettingsRow label="Subject">
                        <Input
                          value={genericSubject}
                          onChange={(e) => setGenericSubject(e.target.value)}
                          placeholder="Reliable masterbatch for {{company}}"
                          maxLength={300}
                          className="max-w-md"
                        />
                      </SettingsRow>
                      <div className="space-y-2">
                        <Label>Body</Label>
                        <HtmlRichTextEditor
                          value={genericBody}
                          onChange={setGenericBody}
                          templateVars={LEAD_TEMPLATE_VARS}
                          minHeight={220}
                          placeholder="Write the exact email body"
                        />
                      </div>
                    </section>
                  )}

                  {isManager && aiSection === "followup" && (
                    <section className="space-y-4">
                      <SectionHeader title="Fallback follow-up" />
                      <p className="text-[13px] text-muted-foreground">
                        Sent for any follow-up step (2, 3, …) whose lead has no AI-personalized
                        follow-up drafted yet — e.g. an AI provider outage, or a follow-up simply
                        not written before it&apos;s due. Without this, that follow-up would send
                        blank. Every lead is seeded with this text the moment a campaign sends;
                        it&apos;s automatically replaced once a personalized follow-up is drafted
                        and approved for that lead. No subject — a follow-up always threads as a
                        reply to the opening email. Placeholder:{" "}
                        <code className="rounded bg-secondary px-1 py-0.5 text-xs">{"{{first_name}}"}</code>.
                      </p>
                      <div className="space-y-2">
                        <Label>Body</Label>
                        <HtmlRichTextEditor
                          value={followupFallbackBody}
                          onChange={setFollowupFallbackBody}
                          minHeight={200}
                          templateVars={FOLLOWUP_FALLBACK_TEMPLATE_VARS}
                          placeholder="Hi {{first_name}}, Just following up on my previous note — would love your thoughts. Best regards"
                        />
                        <p className="text-xs text-muted-foreground">Left blank, this default text is used. This text is sent as-is — the AI does not rewrite it.</p>
                      </div>
                    </section>
                  )}

                  {isManager && aiSection === "html" && (
                    <section className="space-y-4">
                      <SectionHeader title="Tables in emails" />
                      <SettingsRow
                        label="Allow HTML in emails"
                        description="Lets the AI include an HTML table in an email when it is explicitly asked for."
                      >
                        <Switch checked={allowHtmlEmails} onCheckedChange={setAllowHtmlEmails} />
                      </SettingsRow>
                      <p className="text-[13px] text-muted-foreground">
                        <strong>Off (default):</strong> every email is plain text with bold/italic/links, exactly as today.{" "}
                        <strong>On:</strong> nothing changes for ordinary emails. The AI only adds a table when a
                        campaign instruction or a regenerate request clearly asks for one (e.g. &ldquo;add a
                        comparison table of our grades&rdquo;). The table is cleaned up (no scripts or styles) and
                        Instantly sends it as HTML. Applies to newly written or regenerated drafts; existing drafts are unchanged.
                      </p>
                    </section>
                  )}

                  {isManager && aiSection === "replies" && (
                    <section className="space-y-5">
                      <SectionHeader
                        title="Reply drafting"
                        description="Controls how follow-up replies are drafted after a prospect responds."
                      />

                      <RichTextEditor label="Reply drafter prompt" value={replyDrafterPrompt} onChange={setReplyDrafterPrompt} minHeight={220}
                        helper="Must return JSON with subject and body. Still in active use — this is what writes our human-reviewed reply drafts." />
                      <MandatoryFormattingNotice />
                    </section>
                  )}

                  {isManager && aiSection === "footer" && (
                    <section className="space-y-4">
                      <SectionHeader title="Contact footer" description="Contact lines appended at the end of every generated email." />
                      <RichTextEditor label="Contact footer" value={sigContact} onChange={setSigContact} minHeight={160} singleLineBreaks
                        placeholder={"Kuber Polyplast\n+91-XXXXXXXXXX\nsales@kuberpolyplast.com"} />
                    </section>
                  )}

                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              )}

              {/* ── Knowledge Sources (everyone) ── */}
              {section === "knowledge" && (
                <div className="space-y-8">

                  {/* Company Details */}
                  {activeKnowledgeSection === "company" && (
                    <section className="space-y-5">
                      <SectionHeader title="Identity" description="Who the emails come from and what the AI knows about your company." />

                      <div>
                        <SettingsRow label="Default sender name" description={'Used as the "From" name in outreach emails.'}>
                          <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Kuber Polyplast" className="max-w-sm" />
                        </SettingsRow>
                        <SettingsRow label="Client industry">
                          <Input value={clientIndustry} onChange={(e) => setClientIndustry(e.target.value)} placeholder="Plastics & Polymer Manufacturing" className="max-w-sm" />
                        </SettingsRow>
                        <SettingsRow label="Logo" description="PNG/JPG/WebP, up to 2 MB. Appears in the sidebar.">
                          <div className="flex items-center gap-3 flex-wrap">
                            {logoUrl
                              ? <img src={logoUrl} alt="Brand logo" className="size-10 rounded-md border border-border bg-card object-contain shrink-0" />
                              : <div className="size-10 rounded-md border border-border bg-card flex items-center justify-center shrink-0"><span className="text-xs font-semibold text-muted-foreground">K</span></div>
                            }
                            <Input
                              ref={logoInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={(e) => void handleLogoPick(e.target.files?.[0] ?? null)}
                            />
                            <Button type="button" variant="outline" disabled={logoUploading} onClick={() => logoInputRef.current?.click()}>
                              {logoUploading ? "Uploading..." : (logoUrl ? "Replace logo" : "Upload logo")}
                            </Button>
                            {logoPath && (
                              <Button type="button" variant="outline" disabled={logoUploading} onClick={() => void handleLogoRemove()}>Remove</Button>
                            )}
                          </div>
                        </SettingsRow>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-[13px] font-medium">Company context</Label>
                        <Textarea
                          value={companyContext}
                          onChange={(e) => setCompanyContext(e.target.value)}
                          placeholder="Who Kuber Polyplast is, what makes it credible, key accolades — background the AI can draw on in every email and reply."
                          className="min-h-32 text-sm resize-y"
                        />
                        <p className="text-[13px] text-muted-foreground">
                          Given to the AI as background for every draft and reply. Products belong in the Product Offerings tab — the AI reads that library directly.
                        </p>
                      </div>
                    </section>
                  )}

                  {/* Product Offerings */}
                  {activeKnowledgeSection === "products" && (
                    <div className="space-y-4">
                      <SectionHeader
                        title="Products"
                        description="The AI picks the best-matching product for each lead and uses its description as context."
                        aside={
                          <Button type="button" size="sm" variant="outline" onClick={addProduct}>
                            <Plus className="size-3.5" /> Add product
                          </Button>
                        }
                      />

                      {productOfferings.length === 0 && (
                        <EmptyState icon={Package} message={<>No products yet — click &quot;Add product&quot; to get started.</>} />
                      )}

                      <div className="grid gap-3 lg:grid-cols-2">
                        {productOfferings.map((product, idx) => (
                          <div key={idx} className="rounded-lg border border-border bg-card p-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{idx + 1}</span>
                              <Input
                                value={product.name}
                                onChange={(e) => updateProduct(idx, "name", e.target.value)}
                                placeholder="Product name"
                                className="font-medium flex-1"
                              />
                              <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeProduct(idx)}
                                className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                                <X className="size-3.5" />
                              </Button>
                            </div>
                            <Textarea
                              value={product.description}
                              onChange={(e) => updateProduct(idx, "description", e.target.value)}
                              placeholder="Describe this product — what it is, who it fits, key benefits..."
                              className="min-h-32 resize-y"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Industry Segments — the taxonomy behind the Apollo import dropdown */}
                  {activeKnowledgeSection === "industry-segments" && (
                    <div className="space-y-4">
                      <SectionHeader
                        title="Groups and keywords"
                        description={<>Shown in the Apollo import dropdown. Each keyword&apos;s &quot;Apollo search term&quot; is the actual text sent to Apollo — keep it short and plain, since Apollo matches it near-literally.</>}
                        aside={
                          <Button type="button" size="sm" variant="outline" onClick={addGroup} disabled={savingGroupIds.size > 0}>
                            {savingGroupIds.size > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add group
                          </Button>
                        }
                      />

                      {industryKeywordGroups.length === 0 && (
                        <EmptyState icon={Tags} message={<>No groups yet — click &quot;Add group&quot; to get started.</>} />
                      )}



                      <div className="space-y-3">
                        {industryKeywordGroups.map((group, groupIdx) => {
                          const groupEditing = editingGroupIds.has(group.id);
                          const groupSaving = savingGroupIds.has(group.id);
                          return (
                            <div key={group.id} className="rounded-lg border border-border bg-card overflow-hidden">
                              {/* Header bar — the card's one pencil toggles the whole card between view and edit, and doubles as "save" on the way out */}
                              <div className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-1.5">
                                {groupEditing ? (
                                  <Input
                                    value={group.label}
                                    onChange={(e) => updateGroup(groupIdx, e.target.value)}
                                    placeholder="Group name"
                                    className="font-medium flex-1"
                                    disabled={groupSaving}
                                    autoFocus
                                  />
                                ) : (
                                  <span className="text-sm font-semibold flex-1 px-1">{group.label || "Untitled group"}</span>
                                )}
                                <Button type="button" variant="ghost" size="icon-sm" onClick={() => toggleGroupEdit(group.id)}
                                  disabled={groupSaving} className="shrink-0 text-muted-foreground hover:text-foreground">
                                  {groupSaving ? <Loader2 className="size-3.5 animate-spin" /> : groupEditing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
                                </Button>
                                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setGroupPendingDelete({ idx: groupIdx, label: group.label || "this group" })}
                                  disabled={groupSaving} className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                                  <X className="size-3.5" />
                                </Button>
                              </div>

                              <div className="p-3 space-y-2">
                                <div className="space-y-2">
                                  {group.keywords.map((kw, kwIdx) => (
                                    <div key={kw.id} className="flex items-center gap-2">
                                      {groupEditing ? (
                                        <>
                                          <div className="grid grid-cols-2 gap-2 flex-1">
                                            <Input
                                              value={kw.label}
                                              onChange={(e) => updateKeyword(groupIdx, kwIdx, "label", e.target.value)}
                                              placeholder="Label shown in the dropdown"
                                              disabled={groupSaving}
                                            />
                                            <Input
                                              value={kw.query}
                                              onChange={(e) => updateKeyword(groupIdx, kwIdx, "query", e.target.value)}
                                              placeholder="Apollo search term"
                                              disabled={groupSaving}
                                            />
                                          </div>
                                          <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeKeyword(groupIdx, kwIdx)}
                                            disabled={groupSaving} className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                                            <X className="size-3.5" />
                                          </Button>
                                        </>
                                      ) : (
                                        <span className="text-[13px] flex-1 px-1">
                                          {kw.label || "Untitled keyword"}
                                          <span className="text-muted-foreground text-xs"> — searches &quot;{kw.query || kw.label}&quot;</span>
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>

                                {groupEditing && (
                                  <Button type="button" variant="outline" size="sm" onClick={() => addKeyword(groupIdx)} disabled={groupSaving}>
                                    <Plus className="size-3.5" /> Add keyword
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <ConfirmDialog
                        open={!!groupPendingDelete}
                        title={`Delete "${groupPendingDelete?.label ?? ""}"?`}
                        description="This removes the group and every keyword in it from the Apollo import dropdown for everyone. This can't be undone."
                        confirmLabel="Delete group"
                        loading={deletingGroup}
                        onClose={() => setGroupPendingDelete(null)}
                        onConfirm={() => void confirmRemoveGroup()}
                      />
                    </div>
                  )}

                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              )}

              {/* ── Appearance ── */}
              {section === "appearance" && (
                <div>
                  <section>
                    <SectionHeader title="Mode" />
                    <SettingsRow label="Workspace mode" description="Switch between a dark or light workspace ">
                      <div className="grid grid-cols-2 gap-3 max-w-sm">
                        {(["dark", "light"] as const).map((m) => {
                          const active = mode === m;
                          const Icon = m === "dark" ? Moon : Sun;
                          return (
                            <Button key={m} type="button" variant="outline" onClick={() => void setMode(m)} disabled={savingTheme}
                              className={cn("h-auto justify-start gap-2.5 p-3 font-medium shadow-none",
                                active ? "border-primary/50 bg-primary/5 hover:bg-primary/5" : "border-border bg-field")}>
                              <Icon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="flex-1 text-[13px] font-medium capitalize">{m}</span>
                              {active && <Check className="size-4 text-primary shrink-0" />}
                            </Button>
                          );
                        })}
                      </div>
                    </SettingsRow>
                  </section>

                  {/* Color theme — the literal "masterbatch color chip" this whole
                      design language is inspired by. The one place a larger, more
                      expressive swatch presentation is warranted. Logic/COLORS list
                      untouched — visual chrome only. */}
                  <section className="mt-8">
                    <SectionHeader title="Color theme" />
                    <SettingsRow label="Accent color" description="Choose an accent color for the workspace — like picking a pellet reference chip.">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {COLORS.map((t) => {
                          const active = theme === t.id;
                          return (
                            <Button key={t.id} type="button" variant="outline" onClick={() => void setTheme(t.id)} disabled={savingTheme}
                              className={cn(
                                "h-auto flex-col items-stretch gap-2.5 p-2.5 text-left overflow-hidden shadow-none",
                                active ? "border-primary/50 bg-primary/5 hover:bg-primary/5" : "border-border bg-field",
                              )}>
                              <span
                                className="block h-10 w-full rounded shrink-0 border border-black/10 dark:border-white/10"
                                style={{ backgroundColor: t.swatch }}
                                aria-hidden
                              />
                              <span className="flex items-center justify-between gap-2">
                                <span className="text-[13px] font-medium">{t.label}</span>
                                {active && <Check className="size-4 text-primary shrink-0" />}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    </SettingsRow>
                  </section>
                </div>
              )}

              {/* ── Account ── */}
              {section === "account" && (
                <div>
                  <section>
                    <SectionHeader title="Change password" />
                    <form onSubmit={handleChangePassword}>
                      <SettingsRow label="Current password">
                        <Input
                          type="password"
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          required
                          autoComplete="current-password"
                          className="max-w-sm"
                        />
                      </SettingsRow>
                      <SettingsRow label="New password" description="At least 8 characters.">
                        <Input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          required
                          minLength={8}
                          autoComplete="new-password"
                          className="max-w-sm"
                        />
                      </SettingsRow>
                      <SettingsRow label="Confirm password">
                        <Input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          required
                          minLength={8}
                          autoComplete="new-password"
                          className="max-w-sm"
                        />
                      </SettingsRow>
                      <div className="flex justify-end pt-4">
                        <Button type="submit" disabled={savingPassword}>
                          {savingPassword ? "Updating…" : "Update password"}
                        </Button>
                      </div>
                    </form>
                  </section>

                  <section className="mt-8">
                    <SectionHeader title="Session" />
                    <SettingsRow label="Signed in as" description={userEmail}>
                      <span className="rounded-[5px] px-1.5 py-[3px] text-xs font-medium leading-none bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Active</span>
                    </SettingsRow>
                    <SettingsRow label="Sign out" description="End your current session on this device.">
                      <Button type="button" variant="outline" onClick={() => supabase.auth.signOut()}
                        className="text-muted-foreground hover:text-red-600 hover:border-red-500/30 hover:bg-red-500/5 dark:hover:text-red-400">
                        <LogOut className="size-3.5" /> Sign out
                      </Button>
                    </SettingsRow>
                  </section>
                </div>
              )}

              {section === "team" && role === "manager" && <TeamView />}

              {section === "email" && isManager && <EmailSendingView />}

            </div>
          )}

          {showSaveBar && (
            <div className="sticky bottom-0 border-t border-border bg-background">
              <div className="mx-auto flex w-full max-w-3xl justify-end px-8 py-3">
                <Button onClick={handleSave} disabled={saving} className="min-w-20">
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
