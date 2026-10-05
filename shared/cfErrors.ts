// Shared across Node and Workers. Never emit authentication values in diagnostic output.
const secrets = new Set<string>();
export function rememberSecret(value: string | null | undefined): void {
  if (value && value.length >= 4) secrets.add(value);
}

export function redact(value: unknown): string {
  let text = typeof value === 'string' ? value : value instanceof Error ? value.message : JSON.stringify(value) ?? String(value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:authorization|x-auth-key|api[_-]?token|api[_-]?key|global[_-]?api[_-]?key|cookie|set-cookie|session|password|secret|encryption[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}\n]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function redactDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|x-auth-key|api[_-]?token|api[_-]?key|cookie|set-cookie|session|password|secret|encryption[_-]?key)$/i.test(key) ? '[REDACTED]' : redactDiagnostic(item)]));
  return value;
}

export type CfFailureKind = 'invalid' | 'permission' | 'network' | 'timeout' | 'rate_limited' | 'error';
export class CloudflareError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly kind: CfFailureKind;
  readonly status: number;
  readonly cfCodes: Array<string | number>;
  constructor(status: number, message: string, cfCodes: Array<string | number> = [], context = '') {
    const kind = status === 401 ? 'invalid' : status === 403 ? 'permission' : status === 429 ? 'rate_limited' : 'error';
    super(redact(`${context ? `${context}: ` : ''}Cloudflare HTTP ${status}${cfCodes.length ? ` Code ${cfCodes.join(', ')}` : ''}: ${message}`));
    this.status = status; this.cfCodes = cfCodes;
    this.name = 'CloudflareError';
    this.kind = kind;
    this.code = `CF_${kind.toUpperCase()}`;
    this.statusCode = status >= 400 && status <= 599 ? status : 502;
  }
}

export function errorDetails(error: unknown): { message: string; code: string; statusCode: number; kind: CfFailureKind } {
  const e = error as { message?: string; code?: string | number; status?: number; statusCode?: number; name?: string; kind?: CfFailureKind; error?: { errors?: Array<{ code: number; message: string }> } } | null;
  const status = e?.statusCode || e?.status || 500;
  const timeout = /Abort|Timeout/.test(e?.name || '');
  const kind = e?.kind || (timeout ? 'timeout' : status === 401 ? 'invalid' : status === 403 ? 'permission' : status === 429 ? 'rate_limited' : status === 500 && /fetch|network|connect|ECONN|ENOTFOUND/i.test(e?.message || '') ? 'network' : 'error');
  const codes = e?.error?.errors?.map(x => x.code).join(', ');
  return {
    message: redact(`${e?.message || String(error)}${codes ? ` (Cloudflare Code ${codes})` : ''}${e?.status && !(error instanceof CloudflareError) ? ` [HTTP ${status}]` : ''}`),
    code: typeof e?.code === 'string' ? e.code : kind !== 'error' ? `CF_${kind.toUpperCase()}` : 'INTERNAL_ERROR',
    statusCode: timeout ? 504 : kind === 'network' ? 502 : status >= 400 && status <= 599 ? status : 500,
    kind,
  };
}
