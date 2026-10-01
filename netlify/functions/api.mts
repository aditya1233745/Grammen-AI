import { getDatabase } from "@netlify/database";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getAgent, getPublicAgentList } from "../../agents.mjs";

const COOKIE_NAME = "grameen_ai_token";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

// Conversation history is capped, not unbounded. Two reasons: (1) sending
// every past message to Claude on every turn makes each request slower as a
// conversation grows — more tokens to process before generation even starts
// — and (2) it directly feeds the local-dev 30-second timeout risk on later
// turns of a long conversation. 30 messages = ~15 exchanges is enough for an
// agent to stay coherent about recent context without that growth problem.
// Older messages remain in Postgres forever either way — this only limits
// what's loaded per request, nothing is ever deleted.
const MAX_HISTORY_MESSAGES = 30;

// ---------- Small helpers (no Express here — Netlify Functions use the
// standard web Request/Response objects, so cookies are handled by hand) ----------

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = decodeURIComponent(pair.slice(idx + 1).trim());
    cookies[key] = val;
  });
  return cookies;
}

function cookieHeader(value, { clear = false } = {}) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  parts.push(clear ? "Max-Age=0" : `Max-Age=${COOKIE_MAX_AGE}`);
  return parts.join("; ");
}

// TypeScript doesn't know about the `Netlify` global Netlify Functions inject
// at runtime — declaring it here silences editor errors without needing an
// extra dependency just for this one type.
declare const Netlify: { env: { get(key: string): string | undefined } };

function json(body: unknown, options: { status?: number; setCookie?: string } = {}): Response {
  const { status = 200, setCookie } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(body), { status, headers });
}

function getUserIdFromRequest(req: Request, jwtSecret: string): number | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret) as { userId: number };
    return payload.userId;
  } catch {
    return null;
  }
}

// Best-effort client IP for rate limiting unauthenticated routes (signup/login).
// Netlify sets this header on incoming requests.
function getClientIp(req: Request): string {
  return req.headers.get("x-nf-client-connection-ip") || "unknown";
}

// Netlify Functions are stateless between invocations, so an in-memory
// counter wouldn't reliably work — this uses Postgres as the shared counter
// instead. Returns true if the request is allowed, false if it should be
// rejected with a 429. Also opportunistically cleans up old log rows for
// this key so the table never grows unbounded.
async function checkRateLimit(db, rateKey: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowSeconds * 1000);
  await db.sql`DELETE FROM rate_limit_log WHERE rate_key = ${rateKey} AND created_at < ${cutoff}`;
  const [{ count }] = await db.sql`
    SELECT COUNT(*)::int AS count FROM rate_limit_log WHERE rate_key = ${rateKey} AND created_at > ${cutoff}
  `;
  if (count >= maxRequests) return false;
  await db.sql`INSERT INTO rate_limit_log (rate_key) VALUES (${rateKey})`;
  return true;
}

// ---------- Agent chat logic (same behavior as the original server.js) ----------

function extractTrendSeries(contentBlocks) {
  const trendToolUseIds = new Set(
    contentBlocks
      .filter((b) => b.type === "mcp_tool_use" && b.input?.params?.engine === "google_trends")
      .map((b) => b.id)
  );
  if (trendToolUseIds.size === 0) return null;

  for (const block of contentBlocks) {
    if (block.type !== "mcp_tool_result" || !trendToolUseIds.has(block.tool_use_id)) continue;
    const text = block.content?.[0]?.text;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const timeline = parsed.interest_over_time?.timeline_data;
      if (!Array.isArray(timeline) || timeline.length === 0) continue;
      const series = timeline
        .map((point) => {
          const raw = point.values?.[0]?.extracted_value ?? point.values?.[0]?.value;
          const value = typeof raw === "string" ? Number(raw) : raw;
          return { label: point.date || point.formattedAxisTime || "", value };
        })
        .filter((p) => typeof p.value === "number" && !Number.isNaN(p.value));
      if (series.length > 1) return series;
    } catch {
      // Not JSON or unexpected shape — skip.
    }
  }
  return null;
}

function parseAgentResponse(textBlocks) {
  // The model sometimes narrates before or between tool calls (e.g. "I'll
  // search for that now!"), which shows up as earlier text blocks. Only the
  // LAST text block should contain the final answer, so we use that alone
  // rather than joining everything — joining would corrupt the JSON with
  // leftover commentary from earlier turns.
  const raw = (textBlocks[textBlocks.length - 1] || "").trim();

  // Even the last block can occasionally have stray commentary around the
  // JSON (e.g. "Here's what I found:\n\n{...}"), so instead of requiring the
  // ENTIRE string to be valid JSON, extract just the {...} substring and
  // parse that. This is the key fix: strict full-string parsing broke the
  // moment the model added any preamble at all.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  const candidate = firstBrace !== -1 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : raw;

  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed.answer === "string") {
      return {
        answer: parsed.answer,
        card: {
          topic: parsed.topic || null,
          tag: parsed.tag || null,
          changePercent: typeof parsed.changePercent === "number" ? parsed.changePercent : null,
          changeDirection: parsed.changeDirection || null,
          results: Array.isArray(parsed.results) ? parsed.results.slice(0, 3) : [],
          insight: parsed.insight || null,
        },
        followUps: Array.isArray(parsed.followUps) ? parsed.followUps.slice(0, 3) : [],
      };
    }
  } catch {
    // Genuinely not full valid JSON — but the response was very likely
    // truncated mid-object (hit the token limit) rather than actually
    // malformed. In that case the "answer" field is usually written first
    // and complete even though later fields got cut off. Try to salvage just
    // that field with a regex before giving up entirely — this is the
    // difference between showing the user a clean sentence versus a raw,
    // broken-looking JSON dump.
    const answerMatch = candidate.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (answerMatch) {
      return {
        answer: answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
        card: null,
        followUps: [],
      };
    }
  }

  // If the model never attempted JSON at all (no "{" found), what's left in
  // `raw` is likely genuine plain-English prose worth showing as-is. If it DID
  // attempt JSON but it was broken beyond salvage, showing that raw fragment
  // would look like an error, so use a clean generic message instead.
  const attemptedJson = raw.indexOf("{") !== -1;
  return {
    answer: attemptedJson
      ? "I found some information but couldn't format it properly — please try asking again."
      : raw || "I couldn't find a clear answer for that — try rephrasing your question.",
    card: null,
    followUps: [],
  };
}

class UpstreamApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function callClaude({ message, history, agent, anthropicKey, serpapiKey }) {
  const messages = [...history, { role: "user", content: message }];
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 650,
      // Prompt caching: each agent's system prompt is long and identical on
      // every single call, so marking it cacheable means repeat requests
      // (very common — same agent, many users, within a 5-minute window)
      // skip reprocessing it entirely. This is the biggest available lever
      // for cutting response latency without changing behavior at all.
      system: [{ type: "text", text: agent.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
      mcp_servers: [{ type: "url", url: `https://mcp.serpapi.com/${serpapiKey}/mcp`, name: "serpapi" }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new UpstreamApiError(data.error?.message || "Upstream API error", response.status);
  }
  return data;
}

// ---------- Route handlers ----------

async function handleSignup(req, db, jwtSecret) {
  const allowed = await checkRateLimit(db, "signup:" + getClientIp(req), 5, 60 * 60);
  if (!allowed) return json({ error: "Too many signup attempts. Please try again in a while." }, { status: 429 });

  const { name, email, password } = await req.json();
  if (!name || !email || !password) return json({ error: "Name, email, and password are all required." }, { status: 400 });
  if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, { status: 400 });

  const existing = await db.sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) return json({ error: "An account with that email already exists." }, { status: 409 });

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db.sql`
    INSERT INTO users (name, email, password_hash)
    VALUES (${name}, ${email}, ${passwordHash})
    RETURNING id, name, email
  `;
  const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: "30d" });
  return json({ id: user.id, name: user.name, email: user.email }, { setCookie: cookieHeader(token) });
}

async function handleLogin(req, db, jwtSecret) {
  const allowed = await checkRateLimit(db, "login:" + getClientIp(req), 10, 5 * 60);
  if (!allowed) return json({ error: "Too many login attempts. Please wait a few minutes and try again." }, { status: 429 });

  const { email, password } = await req.json();
  if (!email || !password) return json({ error: "Email and password are required." }, { status: 400 });

  const [user] = await db.sql`SELECT * FROM users WHERE email = ${email}`;
  if (!user) return json({ error: "Incorrect email or password." }, { status: 401 });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return json({ error: "Incorrect email or password." }, { status: 401 });

  const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: "30d" });
  return json({ id: user.id, name: user.name, email: user.email }, { setCookie: cookieHeader(token) });
}

function handleLogout() {
  return json({ ok: true }, { setCookie: cookieHeader("", { clear: true }) });
}

async function handleMe(req, db, jwtSecret) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Not logged in." }, { status: 401 });
  const [user] = await db.sql`SELECT id, name, email FROM users WHERE id = ${userId}`;
  if (!user) return json({ error: "Not logged in." }, { status: 401 });
  return json(user);
}

async function handleHistory(req, db, jwtSecret, url) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Please log in first." }, { status: 401 });

  const agentId = url.searchParams.get("agentId");
  const agent = getAgent(agentId);
  if (!agent) return json({ error: "Unknown agent." }, { status: 400 });

  const rowsDesc = await db.sql`
    SELECT m.id, m.role, m.content, m.created_at, f.rating
    FROM messages m
    LEFT JOIN message_feedback f ON f.message_id = m.id
    WHERE m.user_id = ${userId} AND m.agent_id = ${agentId}
    ORDER BY m.id DESC
    LIMIT ${MAX_HISTORY_MESSAGES}
  `;
  const rows = rowsDesc.reverse();
  const messages = rows.map((m) => ({
    id: m.id,
    role: m.role,
    createdAt: m.created_at,
    feedback: m.rating || null,
    // Only the display-ready shape goes to the browser — never the raw
    // Anthropic content blocks, which are an internal implementation detail.
    content: m.role === "assistant" ? m.content.display : m.content,
  }));

  const [labelRow] = await db.sql`
    SELECT label FROM conversation_labels WHERE user_id = ${userId} AND agent_id = ${agentId}
  `;
  return json({ messages, label: labelRow?.label || null });
}

async function handleClearHistory(req, db, jwtSecret, url) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Please log in first." }, { status: 401 });

  const agentId = url.searchParams.get("agentId");
  const agent = getAgent(agentId);
  if (!agent) return json({ error: "Unknown agent." }, { status: 400 });

  await db.sql`DELETE FROM messages WHERE user_id = ${userId} AND agent_id = ${agentId}`;
  return json({ ok: true });
}

async function handleSetLabel(req, db, jwtSecret) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Please log in first." }, { status: 401 });

  const { agentId, label } = await req.json();
  const agent = getAgent(agentId);
  if (!agent) return json({ error: "Unknown agent." }, { status: 400 });
  if (typeof label !== "string") return json({ error: 'Missing "label" string.' }, { status: 400 });

  const trimmed = label.trim().slice(0, 60); // keep it short — this shows in a narrow sidebar row

  if (trimmed === "") {
    // Empty label means "reset to the default agent name" — just remove the row.
    await db.sql`DELETE FROM conversation_labels WHERE user_id = ${userId} AND agent_id = ${agentId}`;
    return json({ label: null });
  }

  await db.sql`
    INSERT INTO conversation_labels (user_id, agent_id, label)
    VALUES (${userId}, ${agentId}, ${trimmed})
    ON CONFLICT (user_id, agent_id) DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()
  `;
  return json({ label: trimmed });
}

async function handleSetFeedback(req, db, jwtSecret) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Please log in first." }, { status: 401 });

  const { messageId, rating } = await req.json();
  if (!messageId || (rating !== "up" && rating !== "down" && rating !== null)) {
    return json({ error: 'Missing "messageId" or invalid "rating" (must be "up", "down", or null to clear).' }, { status: 400 });
  }

  // Only allow feedback on a message that actually belongs to this user —
  // prevents one user from rating another user's messages by guessing IDs.
  const [message] = await db.sql`SELECT id FROM messages WHERE id = ${messageId} AND user_id = ${userId}`;
  if (!message) return json({ error: "Message not found." }, { status: 404 });

  if (rating === null) {
    await db.sql`DELETE FROM message_feedback WHERE message_id = ${messageId}`;
    return json({ feedback: null });
  }

  await db.sql`
    INSERT INTO message_feedback (message_id, rating)
    VALUES (${messageId}, ${rating})
    ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, created_at = NOW()
  `;
  return json({ feedback: rating });
}

async function handleChat(req, db, jwtSecret, anthropicKey, serpapiKey) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Please log in first." }, { status: 401 });

  const allowed = await checkRateLimit(db, "chat:" + userId, 20, 5 * 60);
  if (!allowed) return json({ error: "You're sending messages quickly — please wait a moment before asking again." }, { status: 429 });

  const { message, agentId } = await req.json();
  if (!message || typeof message !== "string") return json({ error: 'Missing "message" string.' }, { status: 400 });

  const agent = getAgent(agentId);
  if (!agent) return json({ error: "Unknown agent." }, { status: 400 });

  // Fetch only the most recent messages, newest-first from the DB, then
  // reverse back into chronological order — this is the actual bounded
  // window sent to Claude (see MAX_HISTORY_MESSAGES above).
  const storedDesc = await db.sql`
    SELECT role, content FROM messages
    WHERE user_id = ${userId} AND agent_id = ${agentId}
    ORDER BY id DESC
    LIMIT ${MAX_HISTORY_MESSAGES}
  `;
  const stored = storedDesc.reverse();
  const history = stored.map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? m.content.raw : m.content,
  }));

  let data;
  try {
    data = await callClaude({ message, history, agent, anthropicKey, serpapiKey });
  } catch (err) {
    console.error("Anthropic API error:", err);
    const status = err instanceof UpstreamApiError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Upstream API error";
    return json({ error: message }, { status });
  }

  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  const toolCalls = (data.content || [])
    .filter((b) => b.type === "mcp_tool_use")
    .map((b) => ({ name: b.name, input: b.input }));

  const parsed = parseAgentResponse(textBlocks);
  const trendSeries = extractTrendSeries(data.content || []);
  const display = { answer: parsed.answer, card: parsed.card, followUps: parsed.followUps, trendSeries, toolCalls };

  await db.sql`INSERT INTO messages (user_id, agent_id, role, content) VALUES (${userId}, ${agentId}, 'user', ${JSON.stringify(message)}::jsonb)`;
  // Capture the new assistant message's own id so the frontend can attach
  // thumbs up/down feedback to this specific response.
  const [assistantRow] = await db.sql`
    INSERT INTO messages (user_id, agent_id, role, content)
    VALUES (${userId}, ${agentId}, 'assistant', ${JSON.stringify({ raw: data.content, display })}::jsonb)
    RETURNING id
  `;

  return json({ ...display, messageId: assistantRow.id });
}

// ---------- Entry point ----------

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  const jwtSecret = Netlify.env.get("JWT_SECRET");
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  const serpapiKey = Netlify.env.get("SERPAPI_API_KEY");

  if (!jwtSecret || !anthropicKey || !serpapiKey) {
    console.warn("Missing one or more required environment variables (JWT_SECRET, ANTHROPIC_API_KEY, SERPAPI_API_KEY).");
  }

  // Uses a bring-your-own Postgres connection string (e.g. a free Neon
  // database) via the DATABASE_URL env var, instead of Netlify's own
  // paid-tier managed database. Same db.sql API either way.
  const db = getDatabase({ connectionString: Netlify.env.get("DATABASE_URL") });

  try {
    if (path === "/api/agents" && method === "GET") return json({ agents: getPublicAgentList() });
    if (path === "/api/auth/signup" && method === "POST") return await handleSignup(req, db, jwtSecret);
    if (path === "/api/auth/login" && method === "POST") return await handleLogin(req, db, jwtSecret);
    if (path === "/api/auth/logout" && method === "POST") return handleLogout();
    if (path === "/api/auth/me" && method === "GET") return await handleMe(req, db, jwtSecret);
    if (path === "/api/history" && method === "GET") return await handleHistory(req, db, jwtSecret, url);
    if (path === "/api/history" && method === "DELETE") return await handleClearHistory(req, db, jwtSecret, url);
    if (path === "/api/label" && method === "PUT") return await handleSetLabel(req, db, jwtSecret);
    if (path === "/api/feedback" && method === "PUT") return await handleSetFeedback(req, db, jwtSecret);
    if (path === "/api/chat" && method === "POST") return await handleChat(req, db, jwtSecret, anthropicKey, serpapiKey);
    return json({ error: "Not found." }, { status: 404 });
  } catch (err) {
    console.error("Unhandled server error:", err);
    return json({ error: "Something went wrong on the server." }, { status: 500 });
  }
};

export const config = {
  path: "/api/*",
};
