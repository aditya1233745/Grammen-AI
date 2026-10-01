# Grameen AI

A family of WhatsApp-styled AI agents for small Indian sellers, shopkeepers,
farmers, and rural workers — built for the SerpApi India Hackathon 2026. Real
accounts, real Postgres-backed chat history, and 12 agents that each call
live SerpApi searches via the SerpApi MCP server.

## Table of contents

- [Screenshots](#screenshots)
- [The 12 agents](#the-12-agents)
- [Architecture](#architecture)
- [Advanced features](#advanced-features)
- [Setup](#setup)
- [Project structure](#project-structure)
- [Adding another agent](#adding-another-agent)
- [Known limitations](#known-limitations-be-upfront-about-these-with-judges)

## Screenshots

**Landing page**

![Grameen AI landing page](docs/screenshots/landing-page.png)

**Mandi Mitra AI agent, with the full 12-agent sidebar**

![Grameen AI chat app showing the Mandi Mitra AI agent](docs/screenshots/chat-app.png)

## The 12 agents

| Agent | Helps with | SerpApi engines used |
|---|---|---|
| **Mandi Mitra AI** | Fair prices, demand trends, where to buy/sell | `google_shopping`, `google_trends`, `google_local`, `google_finance` |
| **Krishi Sahayak** | Finding seeds/fertilizer nearby and their price | `google_local`, `google_shopping` |
| **Sarkari Sahayak** | Government schemes (PM-Kisan, crop insurance, subsidies) | `google_search`, `google_news` |
| **Karnataka Mandi Logistics** | Finding transport businesses for produce | `google_local` / `google_maps` |
| **Rozgar Sahayak** | Nearby jobs & daily-wage work | `google_jobs`, `google_local` |
| **Swasthya Sahayak** | Nearby hospitals, clinics, pharmacies | `google_local` / `google_maps`, `google_search` |
| **Shiksha Sahayak** | Scholarships, exams, nearby schools/colleges | `google_search`, `google_news`, `google_local` |
| **Mausam Sahayak** | Weather updates for farming decisions | `google_search` (weather answer box) |
| **Rin Sahayak** | MSME loans, Mudra & Kisan Credit Card info | `google_search`, `google_news` |
| **Bazar Nazar** | Competitor price watch for online sellers | `google_shopping`, `google_trends` |
| **Yatra Sahayak** | Affordable travel to mandis, cities & work | `google_flights`, `google_hotels` |
| **Patent Sahayak** | Check if a product idea already exists | `google_patents` |

**Honest note on the logistics agent**: SerpApi has no live freight-matching
data, so this agent can only surface transport/logistics *businesses* found
via local search — never live truck availability or confirmed pricing. Its
system prompt always says so explicitly. Be upfront about this if a judge asks.

**Honest note on the weather agent**: Mausam Sahayak's weather data comes
from Google's aggregated weather answer box (via `google_search`), not a
dedicated meteorological API. It's fine for general farming-planning
questions but its own greeting explicitly tells users to check IMD
(mausam.imd.gov.in) for anything storm/flood-safety related.

**Honest note on the healthcare agent**: Swasthya Sahayak is a facility
*finder*, not a medical advisor — its system prompt explicitly forbids
diagnosing symptoms or recommending treatment, and redirects emergencies to
India's 108 ambulance helpline.

**Honest note on the travel agent**: Yatra Sahayak can only search flights
and hotels — SerpApi has no bus or train data, which are often the actual
cheapest/most common options for the short-to-medium routes its users need.
Its system prompt requires it to say so explicitly rather than silently only
showing flights and implying they're the best choice.

**Honest note on the patent agent**: Patent Sahayak is informational only —
its system prompt explicitly forbids stating whether something "is
patentable," since that's a legal judgment call, not a search result. It
always points users to a registered patent attorney for real filing
decisions.

**Honest note on Bazar Nazar vs. Mandi Mitra AI**: these two agents use a
similar mechanism (price search) but different scope on purpose — Mandi
Mitra AI is for agricultural/commodity prices at mandis, Bazar Nazar is for
manufactured/retail goods sold online. Worth being able to explain that
distinction clearly if a judge asks why there are two "price" agents.

## Architecture

This app runs entirely on Netlify — no separate server to host:

- **Frontend**: `public/index.html` is the marketing landing page; the actual
  product (login + chat UI) lives at `public/app.html`. Both are static files,
  no build step.
- **Backend**: one Netlify Function (`netlify/functions/api.mts`) handling
  every `/api/*` route. Netlify Functions use the standard web
  `Request`/`Response` objects, not an Express-style `(req, res)` callback —
  if you're used to Express, this is the main mental shift.
- **Database**: real Postgres via the `@netlify/database` package, pointed at
  a **bring-your-own connection string** (`DATABASE_URL`) — this project uses
  a free [Neon](https://neon.tech) database directly, since Netlify's own
  managed database (same underlying tech, resold by Netlify) requires a
  paid/credit-based plan. Same `db.sql` query API either way.

```mermaid
flowchart TD
    U[Browser] -->|API request| F[Netlify Function]
    F -->|call with MCP tools attached| A[Anthropic API - Claude]
    A -->|search tool calls| S[SerpApi MCP server]
    S -->|live results| A
    F -->|reads and writes| D[Postgres on Neon]
    F -->|JSON response| U
```

Each `/api/chat` request: the function checks the session cookie, loads that
user's history for the chosen agent from Postgres, sends it to Claude with
the agent's own system prompt and the SerpApi MCP server attached as a tool
source, gets back a structured JSON reply, saves both turns to Postgres, and
returns the parsed result to the browser.

### Why this replaced the earlier Express + JSON-file version

The original prototype ran a normal long-lived Express server with a JSON
file as a makeshift database. That could never have worked once deployed on
Netlify — Netlify runs your backend as serverless functions, which don't
have a persistent local disk between requests. Moving to a real Postgres
database wasn't just a safety upgrade, it was required for deployment to
work at all.

### Shared response schema

Each agent has its own system prompt (see `agents.mjs`) but they all share
**one JSON output schema** — a deliberate scope-control choice: one generic
result card in the frontend (`addResultCard` in `public/app.html`) renders
all 12 agents' answers, instead of building 12 separate card layouts under
hackathon time pressure.

### Performance: caching and bounded history

Two things keep responses fast as conversations grow, both in
`netlify/functions/api.mts`:

- **Prompt caching** on the system prompt (`cache_control: { type: "ephemeral" }`) — each agent's system prompt is long and identical on every call, so Anthropic skips reprocessing it on repeat requests within a ~5-minute window. This is the single biggest lever available for cutting latency without changing behavior.
- **Bounded conversation history** (`MAX_HISTORY_MESSAGES = 30`) — instead of sending a user's *entire* message history to Claude on every turn (which gets slower as a conversation grows, and directly increases the risk of hitting the local-dev 30-second timeout), only the most recent messages are loaded and sent. Nothing is ever deleted from Postgres — this only limits what's loaded per request. The same cap applies to what's shown in the UI, so what a user sees always matches what the agent actually remembers.

Conversation history also isn't purely additive — the chat header's "⋮"
menu has a **Clear conversation** option (`DELETE /api/history`) that wipes
a user's history for one specific agent, useful for demos and for resetting
a conversation that's gone off track.

Each agent still has exactly **one** continuous conversation (not multiple
ChatGPT-style threads — that was a deliberate scope decision, see the
`conversation_labels` migration comment for why), but it can be **renamed**:
click the ✏️ next to the chat header title to give that ongoing conversation
a custom label (e.g. "iPhone price research" instead of just "Mandi Mitra
AI"), which then shows in both the header and the sidebar preview. Backed by
`PUT /api/label` and the `conversation_labels` table.

## Setup

**Requirements:** Node.js 18+, a Netlify account, and the Netlify CLI
(installed automatically as a dev dependency).

1. Install dependencies:
   ```
   npm install
   ```

2. Log in to Netlify and link this project to a Netlify site (creates one if
   you don't have one yet):
   ```
   npx netlify login
   npx netlify init
   ```

3. Create a free Postgres database at [neon.tech](https://neon.tech) (no card
   required for the free tier). In Neon's SQL Editor, run these three files
   once, in order, to create the schema — Netlify's automatic migration
   runner only applies to its own paid-tier database, not an external one:
   - `netlify/database/migrations/20260919120000_init/migration.sql` (users, messages)
   - `netlify/database/migrations/20260924000000_add_conversation_labels/migration.sql` (conversation labels)
   - `netlify/database/migrations/20260925000000_add_feedback_and_rate_limits/migration.sql` (feedback, rate limiting)

   Copy your project's Postgres connection string from Neon's dashboard.

4. Create a `.env` file in the project root with the following (fill in your
   own real values — never commit this file, it's already in `.gitignore`):
   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   SERPAPI_API_KEY=your_serpapi_api_key_here
   JWT_SECRET=any_long_random_string
   DATABASE_URL=your_neon_connection_string_from_step_3
   ```
   Generate a `JWT_SECRET` with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. Start local development:
   ```
   npm run dev
   ```
   This opens the app at whatever local URL `netlify dev` prints (usually
   http://localhost:8888).

6. When you're ready to deploy for real:
   ```
   npm run deploy
   ```
   For production, set your environment variables as real Netlify env vars
   (Site settings → Environment variables, or `netlify env:set KEY value`)
   rather than relying on your local `.env` file, which never gets deployed.

## Project structure

```
grameen-ai/
├── netlify.toml                        # Points Netlify at public/ + netlify/functions
├── netlify/
│   ├── functions/
│   │   └── api.mts                      # The one backend function — all /api/* routes
│   └── database/
│       └── migrations/
│           ├── 20260919120000_init/
│           │   └── migration.sql        # users + messages tables
│           ├── 20260924000000_add_conversation_labels/
│           │   └── migration.sql        # conversation_labels table
│           └── 20260925000000_add_feedback_and_rate_limits/
│               └── migration.sql        # message_feedback, rate_limit_log tables
│           (all three run manually against Neon — see Setup)
├── agents.mjs                           # All 12 agents' config + system prompts + shared JSON schema
├── public/
│   ├── index.html                       # Marketing landing page
│   └── app.html                          # Auth screen + full chat UI (vanilla JS, no build step)
├── package.json
└── .gitignore
```

## Adding another agent

Add one object to the `agents` array in `agents.mjs` (id, name, icon, color,
tagline, greeting, sampleQuestions, systemPrompt following the shared JSON
schema documented at the top of that file). Nothing else needs to change —
the sidebar, chat rendering, and history are all driven off `/api/agents`.

## Cost: this runs on free tiers

Netlify's own managed database requires a paid/credit-based plan, which is
why this project uses a free [Neon](https://neon.tech) Postgres database
directly instead (see Setup, step 3). Netlify's site hosting and Functions
stay within their free tier for hackathon-scale traffic. The only real,
unavoidable cost is Anthropic API usage for the chat calls themselves.

## Advanced features

### "Streaming" responses — an important honesty note

Responses appear to type themselves out, word by word, similar to ChatGPT.
**This is a client-side animation of a complete response, not real
token-by-token API streaming.** True streaming isn't compatible with this
project's architecture: each agent's reply is a structured JSON object
(`{ answer, card, results, ... }`), and Claude's tool calls to the SerpApi
MCP server resolve server-side inside one request — there's no safe way to
show a user a "partial" JSON object mid-generation without either exposing
raw tool-call noise or risking displaying invalid, half-formed data. Instead,
`typewriterReveal()` in `public/app.html` reveals the already-complete answer
text progressively once the full response has arrived. It's the same visual
effect, achieved differently — worth being upfront about if a judge asks.

### Rate limiting

Netlify Functions are stateless between invocations, so an in-memory
request counter wouldn't work reliably — `checkRateLimit()` in `api.mts`
uses a small Postgres table (`rate_limit_log`) as a shared, persistent
counter instead, cleaning up old entries automatically as it goes. Applied
to three routes: signup (5/hour per IP, prevents spam account creation),
login (10/5min per IP, prevents brute-force password guessing), and chat
(20/5min per user, protects your Anthropic API budget from runaway usage).
A blocked request gets a `429` status and a friendly toast, not a hard error.

### Thumbs up/down feedback

Each agent response has 👍/👎 buttons, backed by `PUT /api/feedback` and a
`message_feedback` table (one rating per message, upsertable — clicking an
already-active button clears it). Feedback state persists and correctly
re-displays when a conversation is reloaded from history, not just for the
message that was live when you rated it.

### Multi-language UI chrome

A language switcher (English / हिंदी / मराठी) appears on both the login
screen and inside the app, translating the app's own interface — buttons,
labels, placeholders, the disclaimer text. This is **separate from and in
addition to** the agents' own multilingual replies (each agent already
replies in whatever language the user writes in, via its system prompt) —
this feature translates the *chrome around* the conversation, not the
conversation content itself. Scope note: the 12 agents' own names, taglines,
and sample questions are intentionally left untranslated — translating
36+ pieces of curated per-agent content across 3 languages was treated as
a separate, larger content task, not part of this pass. Preference is saved
in `localStorage`, so it persists across sessions on the same device.

### Text-to-speech

A 🔊 button next to each response reads the answer aloud using the
browser's built-in `SpeechSynthesis` API — no external dependency, same
approach as the existing voice-input mic button. The voice's language
follows whichever UI language is currently selected.

## Known limitations (be upfront about these with judges)

- No password reset flow, no email verification.
- The model's JSON output is parsed with a graceful fallback to plain text if
  it doesn't match the schema exactly — some responses may show as plain
  bubbles instead of rich cards until the prompts are tuned against real,
  live usage.
- The logistics, weather, travel, healthcare, and patent agents each have a
  specific, disclosed data limitation — see the "Honest note" callouts above.
- Location-aware queries rely on the user typing a place name; no automatic
  geolocation yet.
- Local dev (`netlify dev`) has a hard 30-second synchronous function
  timeout; a query needing multiple SerpApi calls can occasionally hit it.
  Production deploys get 60 seconds instead.
