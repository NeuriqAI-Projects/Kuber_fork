export type UniboxReadStateFilter = "all" | "unread" | "read" | "replied" | "needs_reply" | "no_reply";
export type UniboxInterestFilter = "all" | "lead" | number;

export const READ_STATE_OPTIONS: { value: UniboxReadStateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
  { value: "replied", label: "Replied" },
  { value: "needs_reply", label: "Needs reply" },
  { value: "no_reply", label: "No reply yet" },
];

/** `dot` is the status's colour dot (Attio-style status options). */
export const INTEREST_FILTER_OPTIONS: { value: UniboxInterestFilter; label: string; dot: string }[] = [
  { value: "lead", label: "Lead", dot: "bg-muted-foreground/50" },
  { value: 1, label: "Interested", dot: "bg-green-500" },
  { value: 2, label: "Meeting booked", dot: "bg-purple-500" },
  { value: 3, label: "Meeting completed", dot: "bg-orange-500" },
  { value: 4, label: "Won", dot: "bg-lime-500" },
  { value: 0, label: "Out of office", dot: "bg-blue-500" },
  { value: -1, label: "Not interested", dot: "bg-red-500" },
  { value: -2, label: "Wrong person", dot: "bg-slate-400" },
  { value: -3, label: "Lost", dot: "bg-rose-500" },
];
