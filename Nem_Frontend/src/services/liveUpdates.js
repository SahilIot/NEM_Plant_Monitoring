const API_BASE = import.meta.env.VITE_API_URL || "/api/v1";
const subscribers = new Set();

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 500;

function websocketUrl() {
  const apiUrl = new URL(API_BASE, window.location.href);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.pathname = `${apiUrl.pathname.replace(/\/+$/, "")}/live`;
  apiUrl.search = "";
  apiUrl.hash = "";
  return apiUrl.toString();
}

function notifySubscribers(update) {
  for (const subscriber of subscribers) {
    try {
      subscriber(update);
    } catch (error) {
      console.error("Live update subscriber failed.", error);
    }
  }
}

function connect() {
  if (
    socket ||
    reconnectTimer ||
    subscribers.size === 0 ||
    typeof WebSocket === "undefined"
  ) {
    return;
  }

  const connection = new WebSocket(websocketUrl());
  socket = connection;

  connection.onopen = () => {reconnectDelay = 500;};
  connection.onmessage = (message) => {
    let update;
    try {
      update = JSON.parse(message.data);
    } catch (error) {
      console.error("Received an invalid live update.", error);
      return;
    }
    notifySubscribers(update);
  };
  connection.onerror = () => {
    connection.close();
  };
  connection.onclose = () => {
    if (socket === connection) {
      socket = null;
    }
    if (subscribers.size === 0 || reconnectTimer) {
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}
export function subscribeLiveUpdates(subscriber) {
  subscribers.add(subscriber);
  connect();

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) {
      return;
    }
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      const connection = socket;
      socket = null;
      connection.close();
    }
  };
}