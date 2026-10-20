"use client";

// Skills tab: the jobs Kuber AI is good at, one tap away. A skill either asks a
// ready question, or opens a new chat with a sentence to finish ("Create a
// campaign called …") so the user only fills in the blanks.
import {
  Activity, ArrowRight, Coins, Inbox, ListChecks, MailSearch, Megaphone, MessageCircleQuestion, PauseCircle,
  Reply, Rocket, Search, StickyNote, UserCheck, UserPlus, UserRound, Users,
} from "lucide-react";
import { TopBar, type PanelHost } from "@/components/app/assistant/assistant-chrome";

export type Skill = {
  title: string;
  description: string;
  Icon: typeof Search;
  /** A full question: sent at once. */
  ask?: string;
  /** A sentence to finish: put in the box for the user to complete. */
  template?: string;
  deep?: boolean;
  managerOnly?: boolean;
  note?: string;
};

const ANALYSE: Skill[] = [
  { title: "Today's priorities", description: "Replies waiting, drafts to review, what to do first", Icon: ListChecks, ask: "What should I focus on today?" },
  { title: "Find leads", description: "Any filter: status, country, industry, campaign, owner", Icon: Search, template: "Find leads that are " },
  { title: "Everything about a lead", description: "Company, campaigns, replies, notes and activity", Icon: UserRound, template: "Tell me everything about " },
  { title: "Campaign check-up", description: "Sent, opened, replied, drafts and latest replies", Icon: Megaphone, template: "How is the campaign " },
  { title: "Replies to answer", description: "Who wrote in and is still waiting for us", Icon: Inbox, ask: "Which replies still need an answer from us?" },
  { title: "Pipeline health check", description: "Where leads get stuck, and what to fix first", Icon: Activity, ask: "Give me a full pipeline health check: where are leads getting stuck, and what should we fix first?", deep: true },
  { title: "What leads are asking", description: "Themes in replies, and how to answer them", Icon: MessageCircleQuestion, ask: "Read the replies we got so far. What are people asking for, and how should we answer them?", deep: true },
  { title: "Team workload", description: "Leads, campaigns and replies per teammate", Icon: Users, ask: "How is each teammate doing, and who needs help or more leads?", managerOnly: true },
  { title: "AI spend", description: "Cost by purpose and by person", Icon: Coins, ask: "How much have we spent on AI in the last 30 days, and on what?", managerOnly: true },
];

const ACT: Skill[] = [
  { title: "Build a campaign", description: "New draft campaign from a set of leads", Icon: Rocket, template: "Create a campaign called '' with all enriched leads from " },
  { title: "Add leads to a campaign", description: "Only campaign-ready leads go in", Icon: UserPlus, template: "Add all enriched leads from  to the campaign ''" },
  { title: "Assign leads", description: "To a teammate, or shared round-robin", Icon: UserCheck, template: "Assign all unassigned leads from  to ", managerOnly: true },
  { title: "Draft a reply", description: "AI writes it, you review and send in Unibox", Icon: Reply, template: "Draft a reply to  saying " },
  { title: "Pause or resume", description: "Stop or restart a campaign's sending", Icon: PauseCircle, template: "Pause the campaign ''" },
  { title: "Reveal emails", description: "Find emails for Apollo leads that have none", Icon: MailSearch, template: "Reveal emails for leads without an email from ", managerOnly: true, note: "Uses Apollo credits" },
  { title: "Add a note", description: "Save a note on a lead", Icon: StickyNote, template: "Add a note on : " },
];

function SkillGroup({ title, hint, skills, onPick }: { title: string; hint: string; skills: Skill[]; onPick: (s: Skill) => void }) {
  return (
    <section>
      <div className="px-1 pb-2">
        <p className="text-[12.5px] font-semibold">{title}</p>
        <p className="text-[11.5px] text-muted-foreground">{hint}</p>
      </div>
      {/* Columns follow the panel's width, not the window's: the compact card is narrow on any screen. */}
      <div className="grid gap-2 @lg:grid-cols-2">
        {skills.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onPick(s)}
            className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-hover"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground/80">
              <s.Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold">{s.title}</span>
                {s.deep && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Deep</span>}
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{s.description}</span>
              {s.note && <span className="mt-1 block text-[11px] font-medium text-amber-700 dark:text-amber-400">{s.note}</span>}
            </span>
            <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          </button>
        ))}
      </div>
    </section>
  );
}

export function AssistantSkills({ host, role, onPick }: { host: PanelHost; role: string | null; onPick: (s: Skill) => void }) {
  const visible = (list: Skill[]) => list.filter((s) => !s.managerOnly || role === "manager");
  return (
    <>
      <TopBar title="Skills" subtitle="Things Kuber AI can do for you" host={host} />
      <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-3">
          <SkillGroup title="Find out" hint="Answers from your live data" skills={visible(ANALYSE)} onPick={onPick} />
          <SkillGroup title="Get it done" hint="Shows a confirm card first — nothing changes until you confirm" skills={visible(ACT)} onPick={onPick} />
        </div>
      </div>
    </>
  );
}
