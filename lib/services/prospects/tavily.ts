// Tavily: reads pages Firecrawl shouldn't pay for (LinkedIn) and searches the
// web when a site says too little. 1,000 free credits a month; basic search is
// 1 credit, basic extract is 1 credit per 5 pages
// (https://docs.tavily.com/documentation/api-credits).
const BASE = "https://api.tavily.com";

async function call(secret: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    // include_usage: credits used come back in each reply (the /usage page lags behind).
    body: JSON.stringify({ ...body, include_usage: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`TAVILY_HTTP_${res.status}`), { status: res.status });
  return res.json() as Promise<Record<string, unknown>>;
}

/** Page text, or "" when Tavily could not read it (counts as "nothing found", not an error). */
export async function tavilyExtract(secret: string, url: string): Promise<string> {
  const j = await call(secret, "/extract", { urls: [url], extract_depth: "basic", format: "markdown" });
  const first = (j.results as { raw_content?: string }[] | undefined)?.[0];
  return first?.raw_content ?? "";
}

/** Titles + snippets from the top results, joined as one text block. */
export async function tavilySearch(secret: string, query: string): Promise<string> {
  const j = await call(secret, "/search", { query, search_depth: "basic", max_results: 5 });
  return ((j.results as { title?: string; url?: string; content?: string }[] | undefined) ?? [])
    .map((r) => `${r.title ?? ""} (${r.url ?? ""})\n${r.content ?? ""}`)
    .join("\n\n");
}
