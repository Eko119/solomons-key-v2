import { config } from './config';

export interface SttInput {
  audio: Buffer;
  mime: string;
  language?: string;
}

export interface SttResult {
  text: string;
  provider: string;
  latencyMs: number;
}

export interface TtsInput {
  text: string;
  voiceId?: string;
  elevenVoiceId?: string;
  format?: 'mp3' | 'wav' | 'pcm';
}

export interface TtsResult {
  audio: Buffer;
  mime: string;
  provider: string;
  latencyMs: number;
}

const ELEVEN_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

async function deepgramStt(input: SttInput): Promise<SttResult> {
  if (!config.deepgramApiKey) throw new Error('deepgram: no api key');
  const start = Date.now();
  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('smart_format', 'true');
  if (input.language) url.searchParams.set('language', input.language);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${config.deepgramApiKey}`, 'Content-Type': input.mime },
    body: input.audio,
  });
  if (!res.ok) throw new Error(`deepgram: ${res.status} ${await res.text().catch(() => '')}`);
  const json: any = await res.json();
  const text = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  if (!text) throw new Error('deepgram: empty transcript');
  return { text, provider: 'deepgram', latencyMs: Date.now() - start };
}

async function groqWhisperStt(input: SttInput): Promise<SttResult> {
  if (!config.groqApiKey) throw new Error('groq: no api key');
  const start = Date.now();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(input.audio)], { type: input.mime }), 'audio.bin');
  form.append('model', 'whisper-large-v3');
  if (input.language) form.append('language', input.language);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`groq: ${res.status} ${await res.text().catch(() => '')}`);
  const json: any = await res.json();
  const text = json?.text ?? '';
  if (!text) throw new Error('groq: empty transcript');
  return { text, provider: 'groq', latencyMs: Date.now() - start };
}

async function elevenlabsStt(input: SttInput): Promise<SttResult> {
  if (!config.elevenlabsApiKey) throw new Error('elevenlabs stt: no api key');
  const start = Date.now();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(input.audio)], { type: input.mime }), 'audio.bin');
  form.append('model_id', 'scribe_v1');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenlabsApiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`elevenlabs stt: ${res.status} ${await res.text().catch(() => '')}`);
  const json: any = await res.json();
  const text = json?.text ?? '';
  if (!text) throw new Error('elevenlabs stt: empty transcript');
  return { text, provider: 'elevenlabs', latencyMs: Date.now() - start };
}

export async function transcribe(input: SttInput): Promise<SttResult> {
  const errors: string[] = [];
  for (const [name, fn] of [
    ['deepgram', deepgramStt],
    ['groq', groqWhisperStt],
    ['elevenlabs', elevenlabsStt],
  ] as const) {
    try {
      return await fn(input);
    } catch (err: any) {
      errors.push(`${name}: ${err?.message || err}`);
    }
  }
  throw new Error(`transcribe failed: ${errors.join(' | ')}`);
}

async function cartesiaTts(input: TtsInput): Promise<TtsResult> {
  if (!config.cartesiaApiKey) throw new Error('cartesia: no api key');
  if (!input.voiceId) throw new Error('cartesia: voiceId required');
  const start = Date.now();
  const fmt = input.format || 'mp3';
  const body = {
    model_id: 'sonic-2',
    transcript: input.text,
    voice: { mode: 'id', id: input.voiceId },
    output_format: fmt === 'mp3'
      ? { container: 'mp3', encoding: 'mp3', sample_rate: 44100 }
      : fmt === 'wav'
      ? { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }
      : { container: 'raw', encoding: 'pcm_s16le', sample_rate: 44100 },
    language: 'en',
  };
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': config.cartesiaApiKey,
      'Cartesia-Version': '2024-06-10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`cartesia: ${res.status} ${await res.text().catch(() => '')}`);
  const audio = Buffer.from(await res.arrayBuffer());
  const mime = fmt === 'mp3' ? 'audio/mpeg' : fmt === 'wav' ? 'audio/wav' : 'audio/pcm';
  return { audio, mime, provider: 'cartesia', latencyMs: Date.now() - start };
}

async function elevenlabsTts(input: TtsInput): Promise<TtsResult> {
  if (!config.elevenlabsApiKey) throw new Error('elevenlabs tts: no api key');
  const start = Date.now();
  const voiceId = input.elevenVoiceId || ELEVEN_DEFAULT_VOICE;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenlabsApiKey,
      'Content-Type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: input.text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) throw new Error(`elevenlabs tts: ${res.status} ${await res.text().catch(() => '')}`);
  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, mime: 'audio/mpeg', provider: 'elevenlabs', latencyMs: Date.now() - start };
}

export async function synthesize(input: TtsInput): Promise<TtsResult> {
  const errors: string[] = [];
  for (const [name, fn] of [
    ['cartesia', cartesiaTts],
    ['elevenlabs', elevenlabsTts],
  ] as const) {
    try {
      return await fn(input);
    } catch (err: any) {
      errors.push(`${name}: ${err?.message || err}`);
    }
  }
  throw new Error(`synthesize failed: ${errors.join(' | ')}`);
}

export function voiceProviderStatus(): { stt: string[]; tts: string[] } {
  const stt: string[] = [];
  const tts: string[] = [];
  if (config.deepgramApiKey) stt.push('deepgram');
  if (config.groqApiKey) stt.push('groq');
  if (config.elevenlabsApiKey) stt.push('elevenlabs');
  if (config.cartesiaApiKey) tts.push('cartesia');
  if (config.elevenlabsApiKey) tts.push('elevenlabs');
  return { stt, tts };
}
