import WebSocket from 'ws';

export interface VoiceBridgeOptions {
  url?:     string;
  onAck?:   (payload: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface VoiceBridge {
  send(agentId: string, text: string): boolean;
  close(): void;
  isOpen(): boolean;
}

const DEFAULT_URL    = 'ws://127.0.0.1:7860';
const RECONNECT_MS   = 30_000;

// ---------- BRIDGE-1: warroom health probe ----------
// A singleton long-lived probe connection owns warroomAvailable. Any voice-
// dependent caller must check isWarroomAvailable() first; sends to a known-
// down warroom no-op with a warn log instead of piling up in a queue.
let warroomAvailable = false;
let healthWs:         WebSocket | null = null;
let reconnectTimer:   NodeJS.Timeout | null = null;
let probeStopped      = true;
let firstProbe        = true;

export function isWarroomAvailable(): boolean {
  return warroomAvailable;
}

function setState(nowAvailable: boolean, reason: string): void {
  if (warroomAvailable === nowAvailable && !firstProbe) return;
  if (nowAvailable) {
    console.info('[voice-bridge] warroom up');
  } else if (firstProbe) {
    console.warn(`[voice-bridge] warroom unreachable at startup: ${reason} (retrying every ${RECONNECT_MS / 1000}s)`);
  } else {
    console.warn(`[voice-bridge] warroom down: ${reason}`);
  }
  warroomAvailable = nowAvailable;
  firstProbe = false;
}

function scheduleReconnect(url: string): void {
  if (probeStopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    tryProbe(url);
  }, RECONNECT_MS);
}

function tryProbe(url: string): void {
  if (probeStopped) return;
  if (healthWs) {
    try { healthWs.close(); } catch { /* noop */ }
    healthWs = null;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setState(false, msg);
    scheduleReconnect(url);
    return;
  }

  healthWs = ws;
  ws.on('open', () => setState(true, 'connected'));
  ws.on('error', (err: Error) => {
    console.debug(`[voice-bridge] warroom probe error: ${err?.message || err}`);
  });
  ws.on('close', () => {
    healthWs = null;
    setState(false, 'connection closed');
    scheduleReconnect(url);
  });
}

export function startWarroomHealthProbe(url: string = DEFAULT_URL): void {
  if (!probeStopped) return;
  probeStopped = false;
  firstProbe = true;
  tryProbe(url);
}

export function stopWarroomHealthProbe(): void {
  probeStopped = true;
  warroomAvailable = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (healthWs) {
    try { healthWs.close(); } catch { /* noop */ }
    healthWs = null;
  }
}

// ---------- per-caller streaming bridge ----------
export function connectVoiceBridge(opts: VoiceBridgeOptions = {}): VoiceBridge {
  const url = opts.url || DEFAULT_URL;
  let ws: WebSocket | null = null;
  let queue: { agent_id: string; text: string }[] = [];

  const flush = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length) {
      const m = queue.shift()!;
      ws.send(JSON.stringify({ type: 'speak', agent_id: m.agent_id, text: m.text }));
    }
  };

  const connect = (): void => {
    if (!warroomAvailable) return;
    ws = new WebSocket(url);
    ws.on('open', flush);
    ws.on('message', (data) => {
      try {
        const obj = JSON.parse(String(data));
        opts.onAck?.(obj);
      } catch (err: unknown) {
        opts.onError?.(err);
      }
    });
    ws.on('error', (err) => opts.onError?.(err));
    ws.on('close', () => { ws = null; });
  };

  connect();

  return {
    send(agentId: string, text: string): boolean {
      if (!warroomAvailable) {
        console.warn(`[voice-bridge] drop speak (warroom down) agent=${agentId}`);
        return false;
      }
      queue.push({ agent_id: agentId, text });
      if (!ws) connect();
      else if (ws.readyState === WebSocket.OPEN) flush();
      return true;
    },
    close(): void {
      try { ws?.close(); } catch { /* noop */ }
      ws = null;
      queue = [];
    },
    isOpen(): boolean {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}
