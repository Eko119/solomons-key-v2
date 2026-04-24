import WebSocket from 'ws';

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
