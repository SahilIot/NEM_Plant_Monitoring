const BASE = import.meta.env.VITE_API_URL || "/api/v1";

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail = body?.detail ?? body?.error?.message ?? body ?? res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

export const api = {
  get: async (p) => {
    const result = await req(p);
    return result && Array.isArray(result.items) ? result.items : result;
  },
  post: (p, body = {}) => req(p, { method: "POST", body: JSON.stringify(body) }),
  put: (p, body) => req(p, { method: "PUT", body: JSON.stringify(body) }),
  patch: (p, body) => req(p, { method: "PATCH", body: JSON.stringify(body) }),
  del: (p) => req(p, { method: "DELETE" }),
};