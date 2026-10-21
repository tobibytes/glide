// Tiny Chrome DevTools Protocol client over Node's global WebSocket.
const DEFAULT_TIMEOUT = Number(process.env.GLIDE_CDP_TIMEOUT ?? 10000);

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export function connectCdp(wsUrl, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  let closed = false;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer, method } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result ?? {});
    } else if (msg.method) for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
  };
  ws.onclose = () => {
    closed = true;
    for (const { reject, timer, method } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`CDP ${method}: connection closed`));
    }
    pending.clear();
  };
  const client = {
    send(method, params = {}, { timeout = timeoutMs } = {}) {
      if (closed) return Promise.reject(new Error(`CDP ${method}: connection closed`));
      return new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => {
          pending.delete(n);
          reject(new Error(`CDP ${method} timed out after ${timeout} ms`));
        }, timeout);
        pending.set(n, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    close() {
      closed = true;
      try {
        ws.close();
      } catch {}
    },
    get closed() {
      return closed;
    },
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket connect timed out")), timeoutMs);
    ws.onopen = () => (clearTimeout(timer), resolve(client));
    ws.onerror = (e) => (clearTimeout(timer), reject(new Error(`CDP websocket error: ${e.message ?? e.type}`)));
  });
}
