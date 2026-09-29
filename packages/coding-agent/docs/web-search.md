# Web Search

The `web_search` tool searches the web and returns source URLs the model can cite. It routes each query through the search providers you configure in `websearch.json`, and, when `auto` is on, through the hosted web search of the model your session is already using.

## Where the config lives

senpi reads the first `websearch.json` it finds, in this order:

1. `<project>/.senpi/websearch.json`
2. `<project>/.pi/websearch.json`
3. `~/websearch.json`
4. `~/.senpi/websearch.json`
5. `~/.pi/websearch.json`

With no file, web search uses DuckDuckGo HTML search, plus the session model's hosted search when the session provider offers one.

`/websearch status` shows which config is active, the providers in routing order, the model native search runs on, and the route and model that served the last search.

## Native (hosted) search

When `auto` is `true` (the default), senpi puts a native entry in front of your configured providers. That entry calls the hosted web search of the session's own provider (Anthropic Messages or OpenAI Responses compatible endpoints, the ChatGPT subscription, xAI, DeepSeek, Perplexity, Z.AI, Kimi Code) with the session's own credential. Google Search grounding is never added this way; it is opt-in (see below). Sessions on the first-party Anthropic and OpenAI APIs instead get the provider's server-side search tool in the main request, and `web_search` stays out of the way there.

### Choosing the model native search runs on

A search sub-request only has to find URLs, so it does not need the session's top-tier model. `nativeModel` picks the model it runs on:

```json
{
  "nativeModel": "claude-haiku-4-5",
  "providers": [{ "provider": "duckduckgo-html" }]
}
```

- The value is a model id (or `provider/id`) served by the **same provider, endpoint and credential** as the session model. Native search never switches to another provider or account because of this setting.
- A model that is not on the session's route is ignored: native search uses the session model, and `/websearch status` shows a warning naming the ignored value.
- If the chosen model fails (an HTTP error such as an unknown model, or no search results), the same search is retried on the session model before routing moves on to the next provider. This retry happens even with `"fallback": false`, because it stays on the same route.
- `"nativeModel": "session"` always uses the session model.

### Default search model

Without `nativeModel`, senpi uses the provider's cheaper search model from this table:

| Session route (native mapping) | Default search model |
| --- | --- |
| Anthropic Messages (Claude models, first-party or compatible endpoint) | `claude-haiku-4-5` (or `claude-haiku-4.5` where the provider spells it that way) |
| OpenAI Responses (GPT-5 models, first-party or compatible endpoint) | `gpt-5.6-luna` |
| xAI (Grok models) | `grok-4.3` |
| DeepSeek (`deepseek-v4-*` models) | `deepseek-v4-flash` |
| ChatGPT subscription, Perplexity, Z.AI, Kimi Code, OpenRouter | none: the session model is used |

The default model is used only when all of these hold:

- your model list includes it on the **same provider and endpoint** as the session model, so the search uses the same login;
- its listed price is no higher than the session model's for input and output tokens, and lower for at least one of them;
- it is not the session model itself.

Otherwise, including when prices are not listed (for example a custom provider whose models have zero cost), the session model is used as before. Either way a failed or empty search retries on the session model. `"nativeModel": "session"` turns the default off.

The routing attempts line of each result names the model behind every attempt, for example:

```text
Routing attempts: my-proxy/native (claude-haiku-4-5) failed: Search failed with HTTP 404: model not found -> my-proxy/native (claude-opus-4-5) 5 results
```

### ChatGPT subscription route

The search goes to the subscription's web search tool with your ChatGPT login. A reply counts only when the model actually ran a web search: results come from that search's sources and from the citations in the answer. URLs the model writes in its answer text are never returned as sources. Small realtime models (the `-spark` variants) have no search route.

The `codex` provider id is a separate thing: it calls OpenAI's pay-as-you-go Responses API and needs an `apiKey`.

## Google Search grounding (opt-in)

Google Search grounding runs only when you list a `google` entry in `websearch.json`, because Google bills grounding beyond its free allowance. A Google model session without that entry gets no Google Search grounding.

The search calls `generateContent` with the `google_search` tool. Results are the grounding sources Google returns; an answer without grounding sources counts as no results. Each result URL is Google's grounding redirect link, which forwards to the source page, and the title is usually the source's site name.

A `google` entry without `apiKey` uses your senpi `google` login (Google API key) and a Google model from it; set `model` to choose one. Vertex AI logins are not used.

## Listing login-based routes

List a `google` entry in `websearch.json` to turn on Google Search grounding, or a `chatgpt-subscription` entry to use that login from a session running another provider. Without an `apiKey`, the entry uses the matching senpi login and always sends it to that login's own endpoint; a `baseUrl` on such an entry is ignored. If you have no matching login, senpi skips the entry.

```json
{
  "providers": [
    { "id": "subscription", "provider": "chatgpt-subscription" },
    { "id": "google", "provider": "google" },
    { "id": "free", "provider": "duckduckgo-html" }
  ]
}
```

A `google` entry may also carry its own `apiKey` and `model`. Listing `chatgpt-subscription` is only needed to use that login from a session running another provider.

## Cost

- The ChatGPT subscription route counts against your subscription's usage limits. It does not bill an API account.
- Google Search grounding is opt-in. It may be billed by Google at its grounding price once you pass the free allowance; check Google's pricing for your plan.
- Other session routes bill the session's own provider account. The DuckDuckGo scraper is free.
