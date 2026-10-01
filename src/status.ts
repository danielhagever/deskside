// Live service status from each vendor's own public status feed.
// Every source below was probed on 2026-10-01 and returned JSON.

export type Health = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

export interface ServiceStatus {
  key: string;
  name: string;
  health: Health;
  summary: string;
  incidents: { title: string; impact: string; started?: string; update?: string }[];
  source: string;
  checkedAt: string;
}

type Kind = "statuspage" | "slack" | "google" | "microsoft";

interface ServiceDef {
  name: string;
  kind: Kind;
  url: string;
  aliases: string[];
  msService?: string; // ServiceDisplayName for the Microsoft feed
}

export const SERVICES: Record<string, ServiceDef> = {
  zoom: { name: "Zoom", kind: "statuspage", url: "https://www.zoomstatus.com/api/v2/summary.json", aliases: ["zoom", "zoom meetings"] },
  slack: { name: "Slack", kind: "slack", url: "https://slack-status.com/api/v2.0.0/current", aliases: ["slack"] },
  github: { name: "GitHub", kind: "statuspage", url: "https://www.githubstatus.com/api/v2/summary.json", aliases: ["github", "git hub"] },
  atlassian: {
    name: "Atlassian (Jira, Confluence, Trello)",
    kind: "statuspage",
    url: "https://status.atlassian.com/api/v2/summary.json",
    aliases: ["jira", "confluence", "trello", "atlassian"],
  },
  dropbox: { name: "Dropbox", kind: "statuspage", url: "https://status.dropbox.com/api/v2/summary.json", aliases: ["dropbox"] },
  discord: { name: "Discord", kind: "statuspage", url: "https://discordstatus.com/api/v2/summary.json", aliases: ["discord"] },
  figma: { name: "Figma", kind: "statuspage", url: "https://status.figma.com/api/v2/summary.json", aliases: ["figma"] },
  cloudflare: {
    name: "Cloudflare",
    kind: "statuspage",
    url: "https://www.cloudflarestatus.com/api/v2/summary.json",
    aliases: ["cloudflare"],
  },
  openai: {
    name: "OpenAI (ChatGPT)",
    kind: "statuspage",
    url: "https://status.openai.com/api/v2/summary.json",
    aliases: ["chatgpt", "openai", "chat gpt"],
  },
  claude: { name: "Claude", kind: "statuspage", url: "https://status.claude.com/api/v2/summary.json", aliases: ["claude", "anthropic"] },
  google: {
    name: "Google Workspace (Gmail, Meet, Drive)",
    kind: "google",
    url: "https://www.google.com/appsstatus/dashboard/incidents.json",
    aliases: ["gmail", "google meet", "meet", "google drive", "google docs", "google workspace", "google calendar"],
  },
  outlook: {
    name: "Outlook.com",
    kind: "microsoft",
    url: "https://status.cloud.microsoft/api/posts/m365Consumer",
    aliases: ["outlook", "hotmail", "outlook.com", "email"],
    msService: "Outlook.com",
  },
  teams: {
    name: "Microsoft Teams",
    kind: "microsoft",
    url: "https://status.cloud.microsoft/api/posts/m365Consumer",
    aliases: ["teams", "microsoft teams"],
    msService: "Microsoft Teams Free",
  },
  onedrive: {
    name: "OneDrive",
    kind: "microsoft",
    url: "https://status.cloud.microsoft/api/posts/m365Consumer",
    aliases: ["onedrive", "one drive"],
    msService: "OneDrive",
  },
  office: {
    name: "Microsoft 365 apps",
    kind: "microsoft",
    url: "https://status.cloud.microsoft/api/posts/m365Consumer",
    aliases: ["office", "word", "excel", "powerpoint", "microsoft 365", "office 365"],
    msService: "Office for the web (Consumer)",
  },
};

export function resolveService(input: string): string | null {
  const q = input.trim().toLowerCase();
  if (SERVICES[q]) return q;
  for (const [key, def] of Object.entries(SERVICES)) {
    if (def.aliases.some((a) => a === q)) return key;
  }
  for (const [key, def] of Object.entries(SERVICES)) {
    if (def.aliases.some((a) => q.includes(a))) return key;
  }
  return null;
}

const UA = { "user-agent": "Deskside/0.1 (+https://github.com/danielhagever/deskside)" };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: UA, cf: { cacheTtl: 60, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

function healthFromStatuspage(indicator: string): Health {
  if (indicator === "none") return "operational";
  if (indicator === "maintenance") return "maintenance";
  if (indicator === "minor") return "degraded";
  if (indicator === "major" || indicator === "critical") return "outage";
  return "unknown";
}

export async function checkService(key: string): Promise<ServiceStatus> {
  const def = SERVICES[key];
  if (!def) throw new Error(`unknown service ${key}`);
  const checkedAt = new Date().toISOString();
  const base = { key, name: def.name, source: def.url, checkedAt };
  try {
    if (def.kind === "statuspage") {
      const d = await getJson(def.url);
      const incidents = (d.incidents ?? []).map((i: any) => ({
        title: String(i.name ?? ""),
        impact: String(i.impact ?? ""),
        started: i.started_at ?? i.created_at,
        update: i.incident_updates?.[0]?.body ? String(i.incident_updates[0].body).slice(0, 280) : undefined,
      }));
      const degradedParts = (d.components ?? [])
        .filter((c: any) => c.status && c.status !== "operational" && !c.group)
        .map((c: any) => `${c.name} (${String(c.status).replace(/_/g, " ")})`)
        .slice(0, 6);
      let health = healthFromStatuspage(d.status?.indicator ?? "");
      if (health === "operational" && (d.scheduled_maintenances ?? []).some((m: any) => m.status === "in_progress")) health = "maintenance";
      const summary = [d.status?.description, degradedParts.length ? `Affected: ${degradedParts.join(", ")}` : ""]
        .filter(Boolean)
        .join(". ");
      return { ...base, health, summary: summary || "No description published", incidents };
    }
    if (def.kind === "slack") {
      const d = await getJson(def.url);
      const incidents = (d.active_incidents ?? []).map((i: any) => ({
        title: String(i.title ?? ""),
        impact: String(i.type ?? ""),
        started: i.date_created,
        update: i.notes?.[0]?.body
          ? String(i.notes[0].body)
              .replace(/<[^>]+>/g, "")
              .slice(0, 280)
          : undefined,
      }));
      const outage = incidents.some((i: any) => i.impact === "outage");
      const health: Health = d.status === "ok" ? "operational" : outage ? "outage" : incidents.length ? "degraded" : "unknown";
      return {
        ...base,
        health,
        summary: health === "operational" ? "All Slack services are working" : `${incidents.length} active incident(s)`,
        incidents,
      };
    }
    if (def.kind === "google") {
      const d: any[] = await getJson(def.url);
      const open = d.filter((i) => !i.end);
      const incidents = open.map((i) => ({
        title: `${i.service_name}: ${
          String(i.external_desc ?? "")
            .replace(/\*\*/g, "")
            .split("\n")
            .find((l: string) => l.trim() && !/^summary:?$/i.test(l.trim())) ?? ""
        }`.slice(0, 200),
        impact: String(i.severity ?? i.status_impact ?? ""),
        started: i.begin,
        update: i.most_recent_update?.text ? String(i.most_recent_update.text).replace(/\*\*/g, "").slice(0, 280) : undefined,
      }));
      const health: Health = !open.length ? "operational" : open.some((i) => i.severity === "high") ? "outage" : "degraded";
      return {
        ...base,
        health,
        summary: open.length ? `${open.length} ongoing Google Workspace incident(s)` : "No ongoing Google Workspace incidents",
        incidents,
      };
    }
    // Microsoft consumer feed: one row per service with a Status string.
    const d: any[] = await getJson(def.url);
    const row = d.find((r) => r.ServiceDisplayName === def.msService);
    if (!row) return { ...base, health: "unknown", summary: "Microsoft did not list this service in its consumer feed", incidents: [] };
    const st = String(row.Status ?? "");
    const health: Health = /operational/i.test(st)
      ? "operational"
      : /degrad|advisory|investigat|restor/i.test(st)
        ? "degraded"
        : /interrupt|outage/i.test(st)
          ? "outage"
          : "unknown";
    const incidents = row.Title
      ? [{ title: String(row.Title), impact: st, started: row.LastUpdatedTime, update: String(row.Message ?? "").slice(0, 280) }]
      : [];
    return { ...base, health, summary: `${def.name}: ${st || "no status text"}`, incidents };
  } catch (err) {
    return {
      ...base,
      health: "unknown",
      summary: `Could not reach the ${def.name} status feed (${(err as Error).message})`,
      incidents: [],
    };
  }
}

export function spokenStatus(s: ServiceStatus): string {
  switch (s.health) {
    case "operational":
      return `${s.name} reports everything is working right now, so the problem is probably on your side. Let's troubleshoot it.`;
    case "maintenance":
      return `${s.name} is in scheduled maintenance right now. ${s.incidents[0]?.title ?? ""}`.trim();
    case "degraded":
      return `${s.name} is having problems right now: ${s.incidents[0]?.title || s.summary}. It's not you.`;
    case "outage":
      return `${s.name} has an outage right now: ${s.incidents[0]?.title || s.summary}. It's not you, and I can watch it and tell you when it's fixed.`;
    default:
      return `I couldn't read ${s.name}'s status page right now, so I can't rule out an outage.`;
  }
}
