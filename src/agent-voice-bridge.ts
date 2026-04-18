import WebSocket from 'ws';

export interface VoiceBridgeOptions {
  url?: string;
  onAck?: (payload: any) => void;
  onError?: (err: any) => void;
}

export interface VoiceBridge {
  send(agentId: string, text: string): void;
  close(): void;
  isOpen(): boolean;
}

const DEFAULT_URL = 'ws://127.0.0.1:7860';

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
    ws = new WebSocket(url);
    ws.on('open', flush);
    ws.on('message', (data) => {
      try {
        const obj = JSON.parse(String(data));
        opts.onAck?.(obj);
      } catch (err) {
        opts.onError?.(err);
      }
    });
    ws.on('error', (err) => opts.onError?.(err));
    ws.on('close', () => { ws = null; });
  };

  connect();

  return {
    send(agentId: string, text: string): void {
      queue.push({ agent_id: agentId, text });
      if (ws && ws.readyState === WebSocket.OPEN) flush();
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
