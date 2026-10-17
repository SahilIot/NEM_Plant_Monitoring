const API_BASE = "http://127.0.0.1:8000";

export async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return response.json();
}

export async function apiPost(path, data) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export async function apiPatch(path, data) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export function connectLive(onMessage, onError) {
  const socket = new WebSocket("ws://127.0.0.1:8000/ws");

  socket.onmessage = (event) => {
    onMessage(JSON.parse(event.data));
  };

  socket.onerror = (event) => {
    onError?.(event);
  };

  return socket;
}
