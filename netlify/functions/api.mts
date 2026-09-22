import { getDatabase } from "@netlify/database";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getAgent, getPublicAgentList } from "../../agents.mjs";

const COOKIE_NAME = "grameen_ai_token";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

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
  const raw = textBlocks.join("\n").trim();
  const stripped = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(stripped);
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
    // Not valid JSON — fall through to plain-text fallback.
  }
  return {
    answer: raw || "I couldn't find a clear answer for that — try rephrasing your question.",
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
      max_tokens: 500,
      system: agent.systemPrompt,
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

  const rows = await db.sql`
    SELECT role, content FROM messages
    WHERE user_id = ${userId} AND agent_id = ${agentId}
    ORDER BY id ASC
  `;
  const messages = rows.map((m) => ({
    role: m.role,
    // Only the display-ready shape goes to the browser — never the raw
    // Anthropic content blocks, which are an internal implementation detail.
    content: m.role === "assistant" ? m.content.display : m.content,
  }));
  return json({ messages });
}

async function handleChat(req, db, jwtSecret, anthropicKey, serpapiKey) {
  const userId = getUserIdFromRequest(req, jwtSecret);
  if (!userId) return json({ error: "Please log in first." }, { status: 401 });

  const { message, agentId } = await req.json();
  if (!message || typeof message !== "string") return json({ error: 'Missing "message" string.' }, { status: 400 });

  const agent = getAgent(agentId);
  if (!agent) return json({ error: "Unknown agent." }, { status: 400 });

  const stored = await db.sql`
    SELECT role, content FROM messages
    WHERE user_id = ${userId} AND agent_id = ${agentId}
    ORDER BY id ASC
  `;
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
  await db.sql`INSERT INTO messages (user_id, agent_id, role, content) VALUES (${userId}, ${agentId}, 'assistant', ${JSON.stringify({ raw: data.content, display })}::jsonb)`;

  return json(display);
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
