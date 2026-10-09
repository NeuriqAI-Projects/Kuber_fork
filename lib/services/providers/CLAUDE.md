# lib/services/providers/

- `types.ts` — `ProviderId` and shared key/model types. `provider` is a free text column, checked here.
- `registry.ts` — one table mapping each provider (LLMs + service providers like apollo,
  firecrawl, instantly, jev, tavily) to how to call/check it. New provider = new entry here.
