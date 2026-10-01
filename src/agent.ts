// The "simulated Alexa+" brain behind the demo page. It is an MCP client: it lists Deskside's
// tools and calls them over Streamable HTTP exactly as Alexa+ would, with a Workers AI model
// choosing the tools. The page adds speech in and out with the browser's Web Speech API.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Env } from "./db";
import { resolveService } from "./status";
import { pickPlaybook } from "./playbooks";

// Picked by test/convo.py runs on 2026-10-01: Llama 4 Scout and Mistral Small called the right
// tools every time; Qwen3 30B claimed actions it never took. Scout is the cheapest of the two.
export const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const ALLOWED_MODELS = [
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
];

const SYSTEM = `You are Alexa+, running the Deskside skill: a friendly IT help desk for a home or small office.
Rules:
- Your reply is spoken aloud on an Echo Show, so answer in one to three short sentences, plain words, no markdown, no lists.
- Always use the Deskside tools instead of guessing. If an online service misbehaves, call check_service_status first.
- For a device or connection problem, call start_troubleshooting, then pass every answer the person gives to answer_troubleshooting. Ask exactly the question the tool returns.
- If the person says "continue", "where were we" or answers a yes/no question, call answer_troubleshooting.
- When a tool result contains a "spoken" sentence, say that sentence, lightly adapted. Never invent ticket numbers or statuses.
/no_think`;

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string };

export async function runTurn(
  env: Env,
  mcpFetch: (req: Request) => Promise<Response>,
  origin: string,
  ws: string,
  history: { role: "user" | "assistant"; content: string }[],
  model: string = MODEL,
) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp?ws=${encodeURIComponent(ws)}`), {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => mcpFetch(new Request(input, init)),
  });
  const client = new Client({ name: "deskside-alexa-sim", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const aiTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
  }));

  const messages: Msg[] = [{ role: "system", content: SYSTEM }, ...history.slice(-12)];
  const cards: Record<string, unknown>[] = [];
  const trace: { tool: string; args: unknown }[] = [];
  const spokenThisTurn: string[] = [];
  let lastSpoken = "";

  // Dialog management, the way voice assistants keep a multi-turn flow on rails: while a guided
  // fix is in progress, a short answer ("yes", "no, still nothing", "gmail", "continue") belongs to
  // that fix, so it goes straight to answer_troubleshooting instead of back through the model.
  const utterance = history[history.length - 1]?.content ?? "";
  const active = await env.DB.prepare("SELECT id, playbook FROM sessions WHERE ws = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
    .bind(ws)
    .first<{ id: string; playbook: string }>();
  // Restating the open problem ("the printer is still offline") resumes that fix at the step
  // where it stopped, which is the behaviour people expect from a human tech.
  if (active && pickPlaybook(utterance) === active.playbook && !/^(yes|no|yeah|yep|nope)\b/i.test(utterance.trim())) {
    const r: any = await client.callTool({ name: "start_troubleshooting", arguments: { problem: utterance } });
    trace.push({ tool: "start_troubleshooting", args: { problem: utterance } });
    if (!r.isError) {
      if (r.structuredContent) cards.push({ tool: "start_troubleshooting", ...r.structuredContent });
      await client.close();
      return { reply: String(r.structuredContent?.spoken ?? r.content?.[0]?.text ?? ""), cards, trace };
    }
  }
  if (active && looksLikeAnswer(utterance)) {
    const r: any = await client.callTool({ name: "answer_troubleshooting", arguments: { answer: utterance, session_id: active.id } });
    trace.push({ tool: "answer_troubleshooting", args: { answer: utterance, session_id: active.id } });
    if (!r.isError) {
      if (r.structuredContent) cards.push({ tool: "answer_troubleshooting", ...r.structuredContent });
      await client.close();
      return { reply: String(r.structuredContent?.spoken ?? r.content?.[0]?.text ?? ""), cards, trace };
    }
  }

  if (SMALL_TALK.test(utterance.trim())) {
    await client.close();
    return {
      reply: /^(hi|hello|hey)/i.test(utterance.trim())
        ? "Hi! Tell me what's not working, or ask how your tech is doing today."
        : "You're welcome. I'm here whenever something breaks.",
      cards,
      trace,
    };
  }

  try {
    for (let round = 0; round < 5; round++) {
      const out: any = await env.AI.run(
        model as any,
        { messages, tools: aiTools, max_tokens: 600, ...(round === 0 ? { tool_choice: "required" } : {}) } as any,
      );
      const msg = out?.choices?.[0]?.message ?? { content: out?.response ?? "", tool_calls: out?.tool_calls };
      let rawCalls: any[] = msg.tool_calls ?? [];
    // Some models write the call as text, e.g. start_troubleshooting(problem="...") or
    // {"name": "...", "parameters": {...}}. Recover those instead of speaking them aloud.
    if (!rawCalls.length && typeof msg.content === "string") rawCalls = textualCalls(stripThink(msg.content), tools.map((t) => t.name));
    const calls: { id: string; name: string; args: any }[] = rawCalls.map((c: any, i: number) => ({
        id: c.id ?? `call_${round}_${i}`,
        name: c.function?.name ?? c.name,
        args: parseArgs(c.function?.arguments ?? c.arguments),
      }));
      if (!calls.length) {
        const text = stripThink(String(msg.content ?? "")).trim();
        await client.close();
        // When tools ran this turn, Alexa speaks the tools' own sentences: they carry the real
        // ticket numbers and statuses, so the model cannot paraphrase a fact into a wrong one.
        const reply = spokenThisTurn.length ? [...new Set(spokenThisTurn)].join(" ") : text;
        return { reply: reply || lastSpoken || "Sorry, I didn't catch that.", cards, trace };
      }
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      });
      for (const c of calls) {
        trace.push({ tool: c.name, args: c.args });
        let resultText: string;
        try {
          const r: any = await client.callTool({ name: c.name, arguments: c.args });
          // A failed tool must be reported as failed: otherwise a model happily says "done".
          if (r.isError) spokenThisTurn.push(`Sorry, that didn't work: ${String(r.content?.[0]?.text ?? "unknown error").replace(/^D1_ERROR:\s*/, "")}`);
          if (r.structuredContent) {
            cards.push({ tool: c.name, ...r.structuredContent });
            if (typeof r.structuredContent.spoken === "string") {
              lastSpoken = r.structuredContent.spoken;
              spokenThisTurn.push(lastSpoken);
            }
          }
          resultText = JSON.stringify(r.structuredContent ?? r.content?.map((x: any) => x.text).join(" ") ?? "").slice(0, 3000);
        } catch (e) {
          resultText = `Tool error: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: resultText });
      }
    }
    await client.close();
    return { reply: lastSpoken || "I'm still working on that.", cards, trace };
  } catch (err) {
    // Workers AI unavailable (for example the free daily quota is used up): fall back to a
    // keyword router so the help desk keeps working, just with less flexible language.
    console.error("ai", (err as Error).message);
    const route = routeByKeywords(utterance);
    if (!route) {
      await client.close();
      return {
        reply:
          "My language model is resting right now. Try a simple request like: is Zoom down, the printer is offline, or what tickets do we have.",
        cards,
        trace,
        degraded: true,
      };
    }
    const r: any = await client.callTool({ name: route.name, arguments: route.args });
    trace.push({ tool: route.name, args: route.args });
    if (r.structuredContent) cards.push({ tool: route.name, ...r.structuredContent });
    await client.close();
    return { reply: String(r.structuredContent?.spoken ?? r.content?.[0]?.text ?? ""), cards, trace, degraded: true };
  }
}

const SMALL_TALK =
  /^(ok(ay)?[, ]*)?(thanks|thank you|thx|cool|great|perfect|bye|goodbye|good night|hi|hello|hey|ok|okay)( so much| alexa| you)?[\s!.]*$/i;

export function routeByKeywords(u: string): { name: string; args: Record<string, unknown> } | null {
  const q = u.toLowerCase();
  if (/(how'?s|how is|how are) (our|my|the|things)|briefing|what'?s new|anything new|while i was away/.test(q))
    return { name: "tech_briefing", args: {} };
  if (/\btickets?\b/.test(q) && /(what|list|show|any|open|do we have)/.test(q)) return { name: "list_tickets", args: {} };
  const svc = resolveService(q);
  if (svc && /(down|working|outage|status|problem|broken|loading|slow|not)/.test(q))
    return { name: "check_service_status", args: { service: svc } };
  if (pickPlaybook(q)) return { name: "start_troubleshooting", args: { problem: u } };
  return null;
}

const ANSWER_WORDS = [
  "yes",
  "yeah",
  "yep",
  "no",
  "nope",
  "not",
  "still",
  "continue",
  "worked",
  "works",
  "fixed",
  "all",
  "every",
  "one",
  "only",
  "gmail",
  "google",
  "outlook",
  "hotmail",
  "zoom",
  "teams",
  "meet",
  "error",
  "sure",
  "done",
  "nothing",
];

export function looksLikeAnswer(u: string): boolean {
  const words = u
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 10) return false;
  // Restating the problem ("my email still won't send") means "pick it up again", not "no".
  if (pickPlaybook(u) && !/^(yes|no|yeah|yep|nope)\b/.test(u.toLowerCase().trim())) return false;
  // A new request ("is zoom down", "check slack", "what tickets") is not an answer.
  if (
    /\b(is|are|check|what|which|how|open|list|show|remember|tickets?)\b/.test(u.toLowerCase()) &&
    !/^(yes|no|yeah|nope)\b/.test(u.toLowerCase().trim())
  )
    return false;
  return words.some((w) => ANSWER_WORDS.includes(w));
}

export function textualCalls(text: string, names: string[]): { name: string; arguments: any }[] {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : [j];
    const out = arr.filter((c) => c && names.includes(c.name)).map((c) => ({ name: c.name, arguments: c.parameters ?? c.arguments ?? {} }));
    if (out.length) return out;
  } catch {}
  const m = t.match(/^\[?\s*([a-z_]+)\s*\(([\s\S]*)\)\s*\]?$/);
  if (!m || !names.includes(m[1])) return [];
  const args: Record<string, unknown> = {};
  for (const a of m[2].matchAll(/([a-z_]+)\s*=\s*("([^"]*)"|'([^']*)'|[^,\s)]+)/g)) {
    const v = a[3] ?? a[4] ?? a[2];
    args[a[1]] = /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return [{ name: m[1], arguments: args }];
}

function parseArgs(a: unknown): any {
  if (a && typeof a === "object") return a;
  try {
    return JSON.parse(String(a ?? "{}"));
  } catch {
    return {};
  }
}

function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
}
