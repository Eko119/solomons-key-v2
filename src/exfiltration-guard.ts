interface Pattern { name: string; re: RegExp; }

const PATTERNS: Pattern[] = [
  { name: 'anthropic_key',       re: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },
  { name: 'openai_key',          re: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'google_api_key',      re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: 'google_api_key_new',  re: /AQ\.[A-Za-z0-9_\-]{30,}/g },
  { name: 'telegram_token',      re: /\d{8,10}:[A-Za-z0-9_\-]{35}/g },
  { name: 'aws_key',             re: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret',          re: /[A-Za-z0-9/+=]{40}(?=\s|$)/g },
  { name: 'private_key_pem',     re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g },
  { name: 'jwt_token',           re: /eyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}/g },
  { name: 'hex_secret_32',       re: /\b[0-9a-f]{64}\b/gi },
  { name: 'github_token',        re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'stripe_key',          re: /sk_(live|test)_[A-Za-z0-9]{24,}/g },
  { name: 'base64_potential',    re: /[A-Za-z0-9+/]{40,}={0,2}/g },
  { name: 'url_with_creds',      re: /https?:\/\/[^:@\s]+:[^@\s]+@/g },
  { name: 'ip_port_combo',       re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/g },
  { name: 'bearer_token',        re: /Bearer\s+[A-Za-z0-9\-_\.]{20,}/gi },
  { name: 'system_path',         re: /\/(?:etc|root|proc|sys|boot|dev)(?:\/[\w.\-]+)+/g },
];

export function scanForSecrets(text: string): { found: boolean; matches: string[] } {
  const hits: string[] = [];
  const scan = (haystack: string, suffix = ''): void => {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack)) !== null) {
        hits.push(`${name}${suffix}:redacted`);
        if (!re.global) break;
      }
    }
  };

  scan(text);

  try {
    const urlDecoded = decodeURIComponent(text);
    if (urlDecoded !== text) scan(urlDecoded, '(url_decoded)');
  } catch { /* malformed % escapes — ignore */ }

  const b64Re = /[A-Za-z0-9+/]{40,}={0,2}/g;
  let m: RegExpExecArray | null;
  while ((m = b64Re.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[0], 'base64').toString('utf-8');
      const printable = decoded.replace(/[^\x20-\x7e]/g, '');
      if (printable.length > 20) scan(printable, '(b64_decoded)');
    } catch { /* not valid base64 */ }
  }

  const unique = Array.from(new Set(hits));
  return { found: unique.length > 0, matches: unique };
}

// SEC-2: redact any of the leak patterns above with a fixed token.
// Returned text is safe to persist or forward; matched content is never
// included in the warn log (we log only the pattern name).
const REDACTION = '[REDACTED]';

export function sanitizeOutput(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const before = out;
    out = out.replace(re, REDACTION);
    if (out !== before) console.warn(`[exfil-guard] redacted pattern=${name}`);
  }
  return out;
}
