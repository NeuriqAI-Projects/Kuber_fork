-- Undo of a Decline puts the company back where it was (12 Oct 2026).
-- Before this, Undo always sent it to "Needs review", so a declined Hidden
-- company could be swept into "Approve all" and cost an Apollo credit.
alter table public.prospect_companies add column if not exists declined_from text;
