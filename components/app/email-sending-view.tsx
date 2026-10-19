"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Mail, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/lib/app-context";
import { Button } from "@/components/ui/button";
import { SettingsPageTitle, SettingsRow, SettingsSection } from "@/components/ui/settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchSendingAccounts,
  setSendingAccount,
  type InstantlySendingAccount,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";

export function EmailSendingView() {
  const { session } = useApp();
  const [accounts, setAccounts] = useState<InstantlySendingAccount[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [draftEmail, setDraftEmail] = useState("");
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => accounts.find((account) => account.email === selectedEmail) ?? null,
    [accounts, selectedEmail],
  );

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await fetchSendingAccounts(session.access_token);
      setAccounts(data.accounts);
      setSelectedEmail(data.selected_email);
      setDraftEmail(data.selected_email ?? "");
      setSelectionRequired(data.selection_required);
      if (refresh) toast.success("Mailboxes refreshed from Instantly");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  async function handleSave() {
    if (!session || !draftEmail) return;
    setSaving(true);
    try {
      const result = await setSendingAccount(session.access_token, draftEmail);
      setSelectedEmail(result.selected_email);
      setDraftEmail(result.selected_email);
      setSelectionRequired(false);
      toast.success(`${result.selected_email} will send new campaigns`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="space-y-2">
          <div className="h-5 w-40 rounded bg-secondary" />
          <div className="h-3 w-72 rounded bg-secondary" />
        </div>
        <div className="h-32 rounded-lg border border-border bg-card" />
      </div>
    );
  }

  const activeCount = accounts.filter((account) => account.can_send).length;

  return (
    <div className="max-w-3xl space-y-8">
      <SettingsPageTitle
        title="Email & sending"
        description="Choose one connected Instantly mailbox for new campaign sends."
      />

      <SettingsSection
        title="Default sending account"
        description={<span className="tabular-nums">{accounts.length} connected · {activeCount} able to send</span>}
        headerClassName="gap-4"
        aside={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      >
        <SettingsRow
          label="Mailbox"
          htmlFor="sending-account"
          labelClassName="leading-[inherit]"
          contentClassName="space-y-3"
          description={
            <>
              The list and send status come directly from the Instantly Accounts API.
              Paused or errored mailboxes cannot be selected.
            </>
          }
        >
          <Select value={draftEmail} onValueChange={setDraftEmail}>
            <SelectTrigger id="sending-account">
              <SelectValue placeholder="Select an active Instantly mailbox" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem
                  key={account.email}
                  value={account.email}
                  disabled={!account.can_send}
                >
                  <span className="flex items-center gap-2">
                    <span>{account.email}</span>
                    <span className={cn(
                      "text-[11px]",
                      account.can_send ? "text-emerald-700 dark:text-emerald-400" : "text-destructive",
                    )}>
                      {account.status_label}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end">
            <Button
              onClick={() => void handleSave()}
              disabled={!draftEmail || draftEmail === selectedEmail || saving}
            >
              {saving && <RefreshCw className="size-3.5 animate-spin" />}
              Use account
            </Button>
          </div>
        </SettingsRow>

        <div className={cn(
          "mt-4 flex items-start gap-3 rounded-lg border px-3.5 py-2.5",
          selectionRequired
            ? "border-amber-200 bg-amber-50 dark:border-amber-500/25 dark:bg-amber-500/10"
            : selected?.can_send
              ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10"
              : "border-border bg-secondary",
        )}>
          {selectionRequired ? (
            <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          ) : selected?.can_send ? (
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <Mail className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          )}
          <div>
            <p className="text-[13px] font-medium">
              {selectionRequired
                ? "Select one mailbox"
                : selected?.can_send
                  ? `${selected.email} can send`
                  : "No active sending account selected"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {selectionRequired
                ? "The old configuration contains multiple addresses. Choose which single account new campaigns should use."
                : selected
                  ? `${selected.status_label}${selected.daily_limit != null ? ` · Daily limit ${selected.daily_limit}` : ""}`
                  : "Connect or repair a mailbox in Instantly, then refresh this list."}
            </p>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
