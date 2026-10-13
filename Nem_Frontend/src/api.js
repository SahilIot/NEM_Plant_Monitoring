const BASE = import.meta.env.VITE_API_URL || "/api";

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export const api = {
  get: (p) => req(p),
  post: (p, body = {}) => req(p, { method: "POST", body: JSON.stringify(body) }),
  put: (p, body) => req(p, { method: "PUT", body: JSON.stringify(body) }),
  patch: (p, body) => req(p, { method: "PATCH", body: JSON.stringify(body) }),
  del: (p) => req(p, { method: "DELETE" }),
};