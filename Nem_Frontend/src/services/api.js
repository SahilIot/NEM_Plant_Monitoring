const BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");
export const AUTH_TOKEN_KEY = "access_token";

export function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}


function describeError(body, fallback) {
  if (body && typeof body === "object") {
    const details = body.error?.details;
    if (Array.isArray(details) && details.length) {
      return details
        .map((item) => {
          const where = (item.loc || []).filter((part) => part !== "body").join(".");
          return where ? `${where}: ${item.msg}` : item.msg;
        })
        .join("; ");
    }
    const detail = body.detail ?? body.error?.message;
    if (typeof detail === "string") return detail;
    if (detail) return JSON.stringify(detail);
  }
  if (typeof body === "string" && body.trim()) return body;
  return fallback;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function req(path, opts = {}) {
  let res;
  try {

const token = getAuthToken();

res = await fetch(`${BASE}${path}`, {
  ...opts,
  headers: {
    ...(opts.body && !(opts.body instanceof FormData)
      ? { "Content-Type": "application/json" }
      : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...opts.headers,
  },
});

  } catch {
    throw new ApiError(
      "Cannot reach the backend. Check that the API server is running on port 8000.",
      0
    );
  }

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
    if (res.status === 401 && !pathIsLogin(path)) {
      window.dispatchEvent(new Event("nem-auth-expired"));
    }
    throw new ApiError(describeError(body, res.statusText || "Request failed"), res.status);
  }

  function pathIsLogin(path) {
    return path === "/auth/login";
  }
  return body;
}


async function getAll(path, pageSize = 200) {
  const joiner = path.includes("?") ? "&" : "?";
  const all = [];
  let offset = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await req(`${path}${joiner}limit=${pageSize}&offset=${offset}`);
    if (Array.isArray(page)) return page;
    const items = Array.isArray(page?.items) ? page.items : [];
    all.push(...items);
    offset += items.length;
    if (items.length === 0 || offset >= (page?.total ?? 0)) break;
  }
  return all;
}

// Multipart upload with progress (fetch cannot report upload progress). Same auth and error handling as req().
function upload(path, formData, { method = "POST", onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, `${BASE}${path}`);
    const token = getAuthToken();
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    if (onProgress && request.upload) {
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
    }
    request.onerror = () => reject(new ApiError(
      "Cannot reach the backend. Check that the API server is running on port 8000.",
      0
    ));
    request.onload = () => {
      let body = null;
      if (request.responseText) {
        try {
          body = JSON.parse(request.responseText);
        } catch {
          body = request.responseText;
        }
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(body);
        return;
      }
      if (request.status === 401) window.dispatchEvent(new Event("nem-auth-expired"));
      reject(new ApiError(describeError(body, request.statusText || "Upload failed"), request.status));
    };
    request.send(formData);
  });
}

// Authenticated file download (the token cannot travel in a plain link). The file is saved through the browser.
async function download(path, fallbackName = "download") {
  const token = getAuthToken();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError("Cannot reach the backend. Check that the API server is running on port 8000.", 0);
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 401) window.dispatchEvent(new Event("nem-auth-expired"));
    throw new ApiError(describeError(body, res.statusText || "Download failed"), res.status);
  }
  const blob = await res.blob();
  const match = /filename="?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") || "");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = match ? match[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  get: async (p) => {
    const result = await req(p);
    return result && Array.isArray(result.items) ? result.items : result;
  },
  getAll,
  post: (p, body = {}) => req(p, { method: "POST", body: JSON.stringify(body) }),
  postForm: (p, formData) =>
    req(p, { method: "POST", body: formData }),
  upload,
  download,
  put: (p, body) => req(p, { method: "PUT", body: JSON.stringify(body) }),
  patch: (p, body) => req(p, { method: "PATCH", body: JSON.stringify(body) }),
  del: (p, body) =>
    req(p, {
      method: "DELETE",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
};
