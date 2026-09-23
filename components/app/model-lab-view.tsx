"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import {
  fetchModelLab, runModelLab, voteModelLab, clearModelLabVote, saveLabPromptSet,
  type LabBenchLead, type LabEmail, type LabPromptSet, type LabScoreRow,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { PromptEditor } from "@/components/ui/prompt-editor";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { htmlToPlainText } from "@/lib/utils/email-html";
import { formatUsd } from "@/lib/utils";
import { FlaskConical, Loader2, ThumbsUp, ThumbsDown, Eye, Lock, Maximize2, X } from "lucide-react";

type Mode = "compare" | "prompts" | "scoreboard";

const STEPS = [
  { value: "1", label: "Opening email" },
  { value: "2", label: "Follow-up 1" },
  { value: "3", label: "Follow-up 2" },
];

const org = (l: LabBenchLead) => (Array.isArray(l.organizations) ? l.organizations[0] : l.organizations);
const leadName = (l: LabBenchLead) => [l.first_name, l.last_name].filter(Boolean).join(" ") || "—";

export function ModelLabView() {
  const [mode, setMode] = useState<Mode>("compare");
  const [loading, setLoading] = useState(true);

  const [bench, setBench] = useState<LabBenchLead[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [promptSets, setPromptSets] = useState<LabPromptSet[]>([]);
  const [scoreboard, setScoreboard] = useState<LabScoreRow[]>([]);

  const [leadId, setLeadId] = useState("");
  const [step, setStep] = useState("1");
  const [picked, setPicked] = useState<string[]>([]);
  const [promptSetId, setPromptSetId] = useState<string>("live");
  const [blind, setBlind] = useState(true);
  const [plain, setPlain] = useState(false);

  const [running, setRunning] = useState(false);
  const [runGroup, setRunGroup] = useState<string | null>(null);
  const [emails, setEmails] = useState<LabEmail[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [best, setBest] = useState<string | null>(null);
  const [worst, setWorst] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<LabEmail | null>(null);

  // Prompt tab
  const [setName, setSetName] = useState("");
  const [template, setTemplate] = useState("");
  const [prompt, setPrompt] = useState("");
  const [savingSet, setSavingSet] = useState(false);
  /** Set while an existing prompt set is open in the boxes below, so Save
   *  updates that one instead of quietly creating a near-duplicate. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      const data = await fetchModelLab(session.access_token);
      setBench(data.bench);
      setModels(data.models);
      setPromptSets(data.prompt_sets);
      setScoreboard(data.scoreboard);
      setLeadId((prev) => prev || (data.bench[0]?.id ?? ""));
      setPicked((prev) => (prev.length ? prev : data.models.slice(0, 4)));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeSet = useMemo(
    () => promptSets.find((p) => p.id === promptSetId) ?? null,
    [promptSets, promptSetId],
  );

  async function generate() {
    if (!leadId || picked.length === 0) return;
    setRunning(true);
    setRevealed(false); setBest(null); setWorst(null); setEmails([]); setRunGroup(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await runModelLab(session.access_token, {
        lead_id: leadId,
        step_number: Number(step),
        models: picked,
        prompt_set_id: activeSet?.id ?? null,
        // Only sent when a saved set is chosen — omitted entirely means
        // "use whatever Settings holds", which is the default experiment.
        ...(activeSet ? { template: activeSet.template, prompt: activeSet.prompt } : {}),
      });
      setRunGroup(res.run_group);
      setEmails(res.emails);
      const failed = res.emails.filter((e) => e.error).length;
      if (failed) toast.warning(`${res.emails.length - failed} written, ${failed} failed`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function vote(emailId: string, verdict: "best" | "worst") {
    if (!runGroup) return;
    const current = verdict === "best" ? best : worst;
    const next = current === emailId ? null : emailId;
    if (verdict === "best") setBest(next); else setWorst(next);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      if (next) await voteModelLab(session.access_token, { run_group: runGroup, email_id: next, verdict });
      else await clearModelLabVote(session.access_token, runGroup, verdict);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function revealAndSave() {
    setRevealed(true);
    await load();
    toast.success("Saved to the scoreboard");
  }

  async function savePromptSet() {
    if (!setName.trim()) { toast.error("Give the prompt set a name"); return; }
    setSavingSet(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { prompt_set } = await saveLabPromptSet(session.access_token, {
        ...(editingId ? { id: editingId } : {}),
        name: setName.trim(), scope: "personal",
        template: template.trim() || null, prompt: prompt.trim() || null,
      });
      setPromptSets((p) => (editingId
        ? p.map((x) => (x.id === prompt_set.id ? prompt_set : x))
        : [...p, prompt_set]));
      setPromptSetId(prompt_set.id);
      newPromptSet();
      toast.success(editingId
        ? `Updated "${prompt_set.name}"`
        : `Saved "${prompt_set.name}" — pick it in Compare to try it`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingSet(false);
    }
  }

  /** Open a saved set in the boxes: the only way to read what is in one, and
   *  the reason the list below is clickable rather than a plain read-only row. */
  function openPromptSet(p: LabPromptSet) {
    setEditingId(p.id);
    setSetName(p.name);
    setTemplate(p.template ?? "");
    setPrompt(p.prompt ?? "");
  }

  function newPromptSet() {
    setEditingId(null); setSetName(""); setTemplate(""); setPrompt("");
  }

  const selectedLead = bench.find((l) => l.id === leadId) ?? null;

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading the lab…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <FlaskConical className="size-5 text-primary" />
          <div className="min-w-0">
            <h1 className="font-display text-lg font-semibold">Model Lab</h1>
            <p className="text-xs text-muted-foreground">
              Read the emails, pick the model. Nothing here is ever sent.
            </p>
          </div>
          <div className="ml-auto flex gap-1">
            {(["compare", "prompts", "scoreboard"] as Mode[]).map((m) => (
              <Button key={m} size="sm" variant={mode === m ? "default" : "ghost"}
                onClick={() => setMode(m)} className="capitalize">
                {m}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {bench.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            No leads on the bench yet. An admin sets them with the
            <span className="font-mono"> model_lab_bench_leads </span> setting — five enriched
            leads from your industry, kept fixed so results stay comparable.
          </div>
        )}

        {mode === "compare" && bench.length > 0 && (
          <>
            {/* Controls */}
            <div className="rounded-lg border border-border bg-secondary/30 p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="min-w-[210px] flex-1">
                  <Label className="text-xs">Lead</Label>
                  <Select value={leadId} onValueChange={setLeadId}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {bench.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {org(l)?.name ?? "—"} · {leadName(l)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-[160px]">
                  <Label className="text-xs">Step</Label>
                  <Select value={step} onValueChange={setStep}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STEPS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-[210px]">
                  <Label className="text-xs">Prompt set</Label>
                  <Select value={promptSetId} onValueChange={setPromptSetId}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="live">Live settings</SelectItem>
                      {promptSets.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <Switch id="lab-blind" checked={blind} onCheckedChange={setBlind} />
                  <Label htmlFor="lab-blind" className="text-xs">Blind</Label>
                </div>
                <Button onClick={() => void generate()} disabled={running || picked.length === 0} className="gap-1.5">
                  {running ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
                  {running ? "Writing…" : `Generate ${picked.length}`}
                </Button>
              </div>

              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                {models.map((m) => {
                  const on = picked.includes(m);
                  return (
                    <button key={m} type="button" className="flex items-center gap-2 text-left"
                      onClick={() => setPicked((prev) => (on ? prev.filter((x) => x !== m) : [...prev, m]))}>
                      <AppCheckbox checked={on} size="sm" />
                      <span className={`font-mono text-xs ${on ? "text-foreground" : "text-muted-foreground"}`}>{m}</span>
                    </button>
                  );
                })}
              </div>

              {selectedLead && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {org(selectedLead)?.company_description?.slice(0, 220) ?? "No company description."}
                </p>
              )}
            </div>

            {/* Results */}
            {emails.length > 0 && (
              <>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <p className="text-sm text-muted-foreground">
                    Pick the best, and the worst if one is clearly wrong.
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setPlain((p) => !p)}>
                      {plain ? "Formatted" : "Plain text"}
                    </Button>
                    {!revealed && (
                      <Button size="sm" onClick={() => void revealAndSave()} disabled={!best} className="gap-1.5">
                        <Eye className="size-3.5" /> Reveal &amp; save
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {emails.map((e) => (
                    <EmailCard
                      key={e.id} email={e} blind={blind && !revealed} plain={plain}
                      isBest={best === e.id} isWorst={worst === e.id}
                      onBest={() => void vote(e.id, "best")}
                      onWorst={() => void vote(e.id, "worst")}
                      onExpand={() => setExpanded(e)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {mode === "prompts" && (
          <div className="max-w-3xl space-y-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0">
                <p className="eyebrow">Writing style</p>
                <h2 className="font-display text-base font-semibold">
                  {editingId ? setName || "Prompt set" : "A prompt set to try"}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {editingId
                    ? "Editing a saved set. Changes here never touch Settings."
                    : "The same two boxes as Settings → AI & Outreach. Saving here never changes Settings — pick the set in Compare to write with it."}
                </p>
              </div>
              {editingId && (
                <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={newPromptSet}>
                  New prompt set
                </Button>
              )}
            </div>

            <div>
              <Label htmlFor="lab-set-name" className="text-sm">Name</Label>
              <Input id="lab-set-name" value={setName} onChange={(e) => setSetName(e.target.value)}
                placeholder="Shorter, no boilerplate" className="mt-1 max-w-sm" />
            </div>

            <PromptEditor label="Email template" value={template} onChange={setTemplate} minHeight={200}
              placeholder="Leave empty to keep the saved template"
              helper="The shape of the email. Leave empty and the saved one is used." />

            <PromptEditor label="Drafting prompt" value={prompt} onChange={setPrompt} minHeight={200}
              placeholder="Leave empty to keep the saved prompt"
              helper="Company details, the product library and campaign context are appended automatically. Structure, length and tone come from this prompt." />

            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Lock className="size-3.5 text-primary" /> Always applied on top of the prompt above
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                The bold-the-key-facts and bullet-list rules are appended in code after whichever
                prompt is in effect, exactly as in Settings. They apply to every model equally, so
                they can never explain a difference between two emails.
              </p>
            </div>

            <Button onClick={() => void savePromptSet()} disabled={savingSet} className="gap-1.5">
              {savingSet && <Loader2 className="size-4 animate-spin" />}
              {editingId ? "Save changes" : "Save prompt set"}
            </Button>

            {promptSets.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Saved sets — click one to read or edit it.
                </p>
                <div className="rounded-lg border border-border bg-field dark:bg-card">
                  {promptSets.map((p) => (
                    <button key={p.id} type="button" onClick={() => openPromptSet(p)}
                      className={`flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left last:border-0 hover:bg-secondary/40 ${
                        editingId === p.id ? "bg-primary/10" : ""}`}>
                      <span className="text-sm font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.template ? `${p.template.length} char template` : "no template"}
                        {" · "}
                        {p.prompt ? `${p.prompt.length} char prompt` : "no prompt"}
                      </span>
                      <span className="ml-auto text-xs text-primary">
                        {editingId === p.id ? "Open" : "View"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {mode === "scoreboard" && (
          <Scoreboard rows={scoreboard} />
        )}
      </div>

      {expanded && <ExpandedEmail email={expanded} plain={plain} onClose={() => setExpanded(null)} />}
    </div>
  );
}

function EmailCard({
  email, blind, plain, isBest, isWorst, onBest, onWorst, onExpand,
}: {
  email: LabEmail; blind: boolean; plain: boolean;
  isBest: boolean; isWorst: boolean;
  onBest: () => void; onWorst: () => void; onExpand: () => void;
}) {
  const words = email.body ? htmlToPlainText(email.body).split(/\s+/).filter(Boolean).length : 0;
  return (
    <div className={`flex flex-col overflow-hidden rounded-lg border bg-card ${
      isBest ? "border-primary" : isWorst ? "border-destructive/60" : "border-border"}`}>
      <div className="flex items-center gap-2 border-b border-border bg-secondary/30 px-3 py-2">
        <span className="font-display text-xs font-semibold">
          {blind ? `Email ${email.label}` : email.model}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {email.duration_ms != null && `${(email.duration_ms / 1000).toFixed(1)}s`}
          {words > 0 && ` · ${words}w`}
          {email.cost_usd != null && ` · ${formatUsd(Number(email.cost_usd))}`}
        </span>
      </div>

      <div className="max-h-[320px] min-h-[120px] flex-1 overflow-y-auto px-3 py-3 text-xs leading-relaxed">
        {email.error ? (
          <p className="text-destructive">Failed: {email.error}</p>
        ) : (
          <>
            {email.subject && (
              <p className="mb-2 border-b border-dashed border-border pb-1.5 font-semibold text-foreground">
                {email.subject}
              </p>
            )}
            {plain ? (
              <pre className="whitespace-pre-wrap font-sans text-muted-foreground">
                {htmlToPlainText(email.body ?? "")}
              </pre>
            ) : (
              <div className="rich-body text-muted-foreground [&_b]:text-foreground [&_li]:mb-0.5 [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-4"
                dangerouslySetInnerHTML={{ __html: email.body ?? "" }} />
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button size="sm" variant={isBest ? "default" : "outline"} className="flex-1 gap-1.5"
          onClick={onBest} disabled={!!email.error}>
          <ThumbsUp className="size-3.5" /> Best
        </Button>
        <Button size="sm" variant={isWorst ? "destructive" : "outline"} className="flex-1 gap-1.5"
          onClick={onWorst} disabled={!!email.error}>
          <ThumbsDown className="size-3.5" /> Worst
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onExpand} aria-label="Read full email">
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ExpandedEmail({ email, plain, onClose }: { email: LabEmail; plain: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="font-mono text-sm">{email.model}</span>
          <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="overflow-y-auto px-5 py-4 text-sm">
          {email.subject && <p className="mb-3 font-semibold">{email.subject}</p>}
          {plain ? (
            <pre className="whitespace-pre-wrap font-sans">{htmlToPlainText(email.body ?? "")}</pre>
          ) : (
            <div className="[&_li]:mb-1 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: email.body ?? "" }} />
          )}
        </div>
      </div>
    </div>
  );
}

function Scoreboard({ rows }: { rows: LabScoreRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No comparisons recorded yet.</p>;
  }
  // Grouped by prompt set: a score earned under one wording is not a score
  // under another, so the two must never be summed together.
  const groups = new Map<string, LabScoreRow[]>();
  for (const r of rows) {
    const list = groups.get(r.prompt_set_name) ?? [];
    list.push(r);
    groups.set(r.prompt_set_name, list);
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([name, list]) => (
        <div key={name}>
          <p className="eyebrow mb-2">{name}</p>
          <div className="overflow-x-auto rounded-lg border border-border bg-field dark:bg-card">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Model</th>
                  <th className="px-4 py-2 text-right font-medium">Best</th>
                  <th className="px-4 py-2 text-right font-medium">Worst</th>
                  <th className="px-4 py-2 text-right font-medium">Emails</th>
                  <th className="px-4 py-2 text-right font-medium">Avg time</th>
                  <th className="px-4 py-2 text-right font-medium">Avg cost</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {list.map((r) => (
                  <tr key={r.model} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                    <td className="px-4 py-2 text-right font-semibold">{r.best}</td>
                    <td className={`px-4 py-2 text-right ${r.worst > 0 ? "text-destructive" : ""}`}>{r.worst}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{r.runs}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">
                      {r.avg_ms != null ? `${(r.avg_ms / 1000).toFixed(1)}s` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">
                      {r.avg_cost != null ? formatUsd(Number(r.avg_cost)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
