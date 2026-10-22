const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(typeof body?.error === "string" ? body.error : JSON.stringify(body?.error ?? body));
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("leadintel_token");
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem("leadintel_token", token);
  else localStorage.removeItem("leadintel_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && typeof window !== "undefined") {
    setToken(null);
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
  }

  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ── Auth ─────────────────────────────────────────────────────────
export const api = {
  register: (data: { email: string; password: string; name: string; organizationName: string }) =>
    request<{ token: string; user: any; organization: any }>("/auth/register", { method: "POST", body: JSON.stringify(data) }),
  login: (data: { email: string; password: string }) =>
    request<{ token: string; user: any }>("/auth/login", { method: "POST", body: JSON.stringify(data) }),
  me: () => request<{ user: any }>("/auth/me"),

  // ── Dashboard / analytics ─────────────────────────────────────
  dashboard: () => request<any>("/dashboard"),
  leadsByCountry: () => request<{ data: any[] }>("/analytics/leads-by-country"),
  leadsByIndustry: () => request<{ data: any[] }>("/analytics/leads-by-industry"),
  leadsBySource: () => request<{ data: any[] }>("/analytics/leads-by-source"),
  leadsByDay: (days = 30) => request<{ data: any[] }>(`/analytics/leads-by-day?days=${days}`),
  verificationRate: () => request<{ data: any[] }>("/analytics/verification-rate"),
  qualityDistribution: () => request<any>("/analytics/quality-distribution"),
  campaignPerformance: () => request<{ data: any[] }>("/analytics/campaign-performance"),
  aiCost: (groupBy: "campaign" | "operation" | "tier" = "campaign") =>
    request<{ data: any[]; todayTotalUsd: number }>(`/analytics/ai-cost?groupBy=${groupBy}`),

  // ── Taxonomy ─────────────────────────────────────────────────
  taxonomyTree: () => request<{ data: any[] }>("/taxonomy/tree"),
  countries: () => request<{ data: any[] }>("/countries"),
  createIndustry: (name: string) => request<any>("/industries", { method: "POST", body: JSON.stringify({ name }) }),

  // ── Campaigns ────────────────────────────────────────────────
  listCampaigns: () => request<{ data: any[] }>("/campaigns"),
  getCampaign: (id: string) => request<{ campaign: any; runs: any[] }>(`/campaigns/${id}`),
  createCampaign: (data: any) => request<{ campaign: any }>("/campaigns", { method: "POST", body: JSON.stringify(data) }),
  generateStrategy: (id: string) => request<any>(`/campaigns/${id}/strategy`, { method: "POST" }),
  approveCampaign: (id: string) => request<{ campaign: any }>(`/campaigns/${id}/approve`, { method: "POST" }),
  runCampaign: (id: string, sourceId?: string) =>
    request<any>(`/campaigns/${id}/run`, { method: "POST", body: JSON.stringify(sourceId ? { sourceId } : {}) }),
  attachSource: (campaignId: string, sourceId: string, priority = 0) =>
    request<any>(`/campaigns/${campaignId}/sources`, { method: "POST", body: JSON.stringify({ sourceId, priority }) }),
  campaignSources: (id: string) => request<{ data: any[] }>(`/campaigns/${id}/sources`),
  rankCampaignSources: (id: string) => request<any>(`/campaigns/${id}/sources/rank`, { method: "POST" }),
  campaignLeads: (id: string) => request<{ data: any[] }>(`/campaigns/${id}/leads`),
  scheduleCampaign: (id: string, opts: { cron?: string; everyMs?: number }) =>
    request<any>(`/campaigns/${id}/schedule`, { method: "POST", body: JSON.stringify(opts) }),
  unscheduleCampaign: (id: string) => request<any>(`/campaigns/${id}/schedule`, { method: "DELETE" }),

  // ── Leads ────────────────────────────────────────────────────
  listLeads: (params: Record<string, string | number | boolean | undefined>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== "" && q.set(k, String(v)));
    return request<{ data: any[]; pagination: any }>(`/leads?${q.toString()}`);
  },
  getLead: (id: string) => request<any>(`/leads/${id}`),
  createLead: (data: any) => request<any>("/leads", { method: "POST", body: JSON.stringify(data) }),
  rescoreLead: (id: string) => request<any>(`/leads/${id}/rescore`, { method: "POST" }),
  enrichLead: (id: string) => request<any>(`/leads/${id}/enrich`, { method: "POST" }),
  exportUrl: (params: Record<string, string | number | boolean | undefined>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== "" && q.set(k, String(v)));
    const token = getToken();
    return { url: `${API_BASE}/leads/export?${q.toString()}`, token };
  },

  // ── Review queue ─────────────────────────────────────────────
  reviewQueue: (priority?: string) => request<{ data: any[]; pagination: any }>(`/review-queue${priority ? `?priority=${priority}` : ""}`),
  reviewQueueSummary: () => request<any>("/review-queue/summary"),
  resolveFlag: (id: string, resolution: "approved" | "rejected" | "corrected", note?: string) =>
    request<any>(`/review-queue/${id}/resolve`, { method: "POST", body: JSON.stringify({ resolution, note }) }),

  // ── Sources ──────────────────────────────────────────────────
  listSources: () => request<{ data: any[] }>("/sources"),
  createSource: (data: any) => request<any>("/sources", { method: "POST", body: JSON.stringify(data) }),
  sourceHealth: (id: string) => request<any>(`/sources/${id}/health`),

  // ── System ───────────────────────────────────────────────────
  systemHealth: () => request<any>("/system/health"),
  testAiConnection: () => request<any>("/system/test-ai-connection", { method: "POST" }),
};

export async function downloadExport(params: Record<string, string | number | boolean | undefined>) {
  const { url, token } = api.exportUrl(params);
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename="(.+)"/);
  const filename = match?.[1] ?? "export";
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objectUrl);
}
