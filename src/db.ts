// Small typed helpers over D1. Every row is scoped to a workspace (one household or office).

export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
}

export interface Ticket {
  id: number;
  ws: string;
  status: string;
  priority: string;
  summary: string;
  details: string;
  device: string;
  watch_service: string | null;
  watch_since_status: string | null;
  followup_at: string | null;
  history: { at: string; text: string }[];
  created_at: string;
  updated_at: string;
}

export const now = () => new Date().toISOString();

export function cleanWs(ws: string | null | undefined): string {
  const v = (ws ?? "demo")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return v || "demo";
}

function rowToTicket(r: any): Ticket {
  return { ...r, history: JSON.parse(r.history || "[]") };
}

export async function createTicket(
  env: Env,
  ws: string,
  t: {
    summary: string;
    details?: string;
    priority?: string;
    device?: string;
    watch_service?: string | null;
    watch_since_status?: string | null;
  },
): Promise<Ticket> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE ws = ?").bind(ws).first<{ n: number }>();
  if ((count?.n ?? 0) >= 500) throw new Error("This workspace already has 500 tickets; close some first.");
  const at = now();
  const history = JSON.stringify([{ at, text: "Ticket opened" }]);
  const r = await env.DB.prepare(
    `INSERT INTO tickets (ws, status, priority, summary, details, device, watch_service, watch_since_status, history, created_at, updated_at)
     VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(
      ws,
      t.priority ?? "normal",
      t.summary.slice(0, 200),
      (t.details ?? "").slice(0, 4000),
      (t.device ?? "").slice(0, 80),
      t.watch_service ?? null,
      t.watch_since_status ?? null,
      history,
      at,
      at,
    )
    .first();
  await addEvent(env, ws, "ticket", `Ticket #${(r as any).id} opened: ${t.summary}`);
  return rowToTicket(r);
}

export async function getTicket(env: Env, ws: string, id: number): Promise<Ticket | null> {
  const r = await env.DB.prepare("SELECT * FROM tickets WHERE ws = ? AND id = ?").bind(ws, id).first();
  return r ? rowToTicket(r) : null;
}

export async function listTickets(env: Env, ws: string, status?: string): Promise<Ticket[]> {
  const q = status
    ? env.DB.prepare("SELECT * FROM tickets WHERE ws = ? AND status = ? ORDER BY id DESC LIMIT 50").bind(ws, status)
    : env.DB.prepare("SELECT * FROM tickets WHERE ws = ? AND status IN ('open','waiting','resolved') ORDER BY id DESC LIMIT 50").bind(ws);
  const { results } = await q.all();
  return results.map(rowToTicket);
}

export async function updateTicket(
  env: Env,
  ws: string,
  id: number,
  change: {
    status?: string;
    priority?: string;
    note?: string;
    followup_at?: string | null;
    watch_service?: string | null;
    watch_since_status?: string | null;
  },
): Promise<Ticket> {
  const t = await getTicket(env, ws, id);
  if (!t) throw new Error(`No ticket #${id} in this workspace`);
  const at = now();
  const history = [...t.history];
  if (change.status && change.status !== t.status) history.push({ at, text: `Status ${t.status} -> ${change.status}` });
  if (change.priority && change.priority !== t.priority) history.push({ at, text: `Priority ${t.priority} -> ${change.priority}` });
  if (change.note) history.push({ at, text: change.note.slice(0, 1000) });
  const next = {
    status: change.status ?? t.status,
    priority: change.priority ?? t.priority,
    followup_at: change.followup_at !== undefined ? change.followup_at : t.followup_at,
    watch_service: change.watch_service !== undefined ? change.watch_service : t.watch_service,
    watch_since_status: change.watch_since_status !== undefined ? change.watch_since_status : t.watch_since_status,
  };
  const r = await env.DB.prepare(
    `UPDATE tickets SET status = ?, priority = ?, followup_at = ?, watch_service = ?, watch_since_status = ?, history = ?, updated_at = ?
     WHERE ws = ? AND id = ? RETURNING *`,
  )
    .bind(
      next.status,
      next.priority,
      next.followup_at,
      next.watch_service,
      next.watch_since_status,
      JSON.stringify(history.slice(-60)),
      at,
      ws,
      id,
    )
    .first();
  return rowToTicket(r);
}

export async function addEvent(env: Env, ws: string, kind: string, text: string) {
  await env.DB.prepare("INSERT INTO events (ws, at, kind, text) VALUES (?, ?, ?, ?)").bind(ws, now(), kind, text.slice(0, 500)).run();
}

export async function unseenEvents(env: Env, ws: string, markSeen: boolean) {
  const { results } = await env.DB.prepare("SELECT * FROM events WHERE ws = ? AND seen = 0 ORDER BY id DESC LIMIT 20").bind(ws).all<any>();
  if (markSeen && results.length) await env.DB.prepare("UPDATE events SET seen = 1 WHERE ws = ? AND seen = 0").bind(ws).run();
  return results;
}

export async function recentEvents(env: Env, ws: string, limit = 30) {
  const { results } = await env.DB.prepare("SELECT * FROM events WHERE ws = ? ORDER BY id DESC LIMIT ?").bind(ws, limit).all<any>();
  return results;
}

export async function upsertDevice(env: Env, ws: string, d: { name: string; kind: string; model?: string; notes?: string }) {
  await env.DB.prepare(
    `INSERT INTO devices (ws, name, kind, model, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ws, name) DO UPDATE SET kind = excluded.kind, model = CASE WHEN excluded.model = '' THEN devices.model ELSE excluded.model END,
     notes = CASE WHEN excluded.notes = '' THEN devices.notes ELSE excluded.notes END, updated_at = excluded.updated_at`,
  )
    .bind(ws, d.name.toLowerCase().slice(0, 60), d.kind, (d.model ?? "").slice(0, 80), (d.notes ?? "").slice(0, 500), now())
    .run();
}

export async function listDevices(env: Env, ws: string) {
  const { results } = await env.DB.prepare("SELECT name, kind, model, notes, updated_at FROM devices WHERE ws = ? ORDER BY name")
    .bind(ws)
    .all<any>();
  return results;
}

export async function setServices(env: Env, ws: string, keys: string[]) {
  const stmts = [
    env.DB.prepare("DELETE FROM services WHERE ws = ?").bind(ws),
    ...keys.map((k) => env.DB.prepare("INSERT OR IGNORE INTO services (ws, service) VALUES (?, ?)").bind(ws, k)),
  ];
  await env.DB.batch(stmts);
}

export async function getServices(env: Env, ws: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT service FROM services WHERE ws = ?").bind(ws).all<{ service: string }>();
  return results.map((r) => r.service);
}
