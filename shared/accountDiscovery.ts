import { CloudflareError, errorDetails, rememberSecret, type CfFailureKind } from './cfErrors';
import {normalizeAccountName} from './accountName';

export interface AuthInput { auth_type: 'token' | 'global_key'; api_token?: string; api_key?: string; email?: string }
export interface DiscoveredAccount { id: string; name: string }
export interface CfEnvelope { success?: boolean; result?: unknown; errors?: Array<{ code: number; message: string }>; result_info?: { page?: number; count?: number; total_pages?: number; total_count?: number; per_page?: number;cursor?:string;is_truncated?:boolean;delimited?:string[] } }
export interface HttpResponse { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>;body?:Uint8Array|ReadableStream<Uint8Array>|(AsyncIterable<Uint8Array>&{destroy?():void})|null }
export type Transport = (path: string, init: RequestInit) => Promise<HttpResponse>;
export type CfRequestInit=RequestInit & {retry?:boolean;maxResponseBytes?:number};
export type CfRequest = (path: string, init?: CfRequestInit) => Promise<CfEnvelope>;
export interface DiscoveryResult {
  status: 'discovered' | 'manual_required' | CfFailureKind;
  credentialStatus: 'active' | 'invalid' | 'unknown';
  accounts: DiscoveredAccount[];
  message?: string;
}

export function authHeaders(input: AuthInput): Record<string, string> {
  if (!input || !['token', 'global_key'].includes(input.auth_type) || [input.api_token, input.api_key, input.email].some(value => value !== undefined && typeof value !== 'string')) {
    throw Object.assign(new Error('Invalid authentication fields'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  }
  if (input.auth_type === 'token' && input.api_token?.trim()) {
    rememberSecret(input.api_token.trim());
    return { Authorization: `Bearer ${input.api_token.trim()}` };
  }
  if (input.auth_type === 'global_key' && input.api_key?.trim() && input.email?.trim()) {
    rememberSecret(input.api_key.trim());
    return { 'X-Auth-Key': input.api_key.trim(), 'X-Auth-Email': input.email.trim() };
  }
  throw Object.assign(new Error('API Token or Email + Global API Key is required'), { code: 'VALIDATION_ERROR', statusCode: 400 });
}

// Retry only explicit 429 responses, never ambiguous network failures of a write operation.
export function createCfRequest(transport: Transport, headers: Record<string, string>, context = '', sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), metric: (value: { event: string; attempt: number; durationMs: number; status?: number }) => void = () => {}): CfRequest {
  return async (path, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      const started = Date.now();
      let response: HttpResponse;
      const {retry:_retry,maxResponseBytes:_maxResponseBytes,...transportInit}=init;
      try { response = await transport(path, { ...transportInit, headers: { 'Content-Type': 'application/json', ...headers, ...init.headers } }); }
      catch (error) { metric({ event: `cf_${errorDetails(error).kind}`, attempt, durationMs: Date.now() - started }); throw error; }
      metric({ event: response.status === 429 ? 'cf_rate_limited' : 'cf_attempt', attempt, status: response.status, durationMs: Date.now() - started });
      if (response.status === 429 && attempt < 2 && init.retry!==false) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : retry ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000) : NaN;
        // Long limits are returned to the caller rather than retried earlier than CF requested.
        if (Number.isFinite(seconds) && seconds > 5) throw Object.assign(new CloudflareError(429, `Rate limited; retry after ${Math.ceil(seconds)}s`, [], context),{retryAfterMs:seconds*1000});
        await sleep(Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (response.status === 204) return { success: true, result: null };
      let body: CfEnvelope;
      try {
        if(init.maxResponseBytes&&response.body){
          const chunks:Uint8Array[]=[];let size=0;
          const accept=(chunk:Uint8Array)=>{size+=chunk.length;if(size>init.maxResponseBytes!)throw Object.assign(new Error('D1 result exceeds response limit; add an explicit LIMIT'),{code:'D1_RESULT_LIMIT',statusCode:502});chunks.push(chunk);};
          if(response.body instanceof Uint8Array)accept(response.body);
          else if('getReader' in response.body){const reader=response.body.getReader();try{for(;;){const part=await reader.read();if(part.done)break;accept(part.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}}
          else {try{for await(const chunk of response.body)accept(chunk);}catch(error){response.body.destroy?.();throw error;}}
          const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}body=JSON.parse(new TextDecoder().decode(bytes));
        }else body = await response.json() as CfEnvelope;
      }
      catch (error) {
        if((error as {code?:string}).code==='D1_RESULT_LIMIT')throw error;
        if (['timeout', 'network'].includes(errorDetails(error).kind)) throw error;
        if (response.ok) throw new CloudflareError(502, 'Invalid JSON response', [], context);
        body = {};
      }
      if (!response.ok || body.success === false) {
        const error=new CloudflareError(response.status, body.errors?.map(e => e.message).join('; ') || 'Upstream request failed', body.errors?.map(e => e.code), context);
        if(response.status===429){const retry=response.headers.get('retry-after');const ms=retry&&/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:retry?Date.parse(retry)-Date.now():NaN;if(Number.isFinite(ms))error.retryAfterMs=Math.max(0,ms);}
        throw error;
      }
      return body;
    }
  };
}

export async function listAccessibleAccounts(request: CfRequest): Promise<DiscoveredAccount[]> {
  const accounts = new Map<string, DiscoveredAccount>();
  for (let page = 1; page <= 1000; page++) {
    const data = await request(`/accounts?page=${page}&per_page=50`);
    if (!Array.isArray(data.result)) throw new CloudflareError(502, 'Unexpected accounts response');
    const before = accounts.size;
    for (const row of data.result as DiscoveredAccount[]) {
      if (/^[a-f\d]{32}$/i.test(row.id) && typeof row.name === 'string') accounts.set(row.id, { id: row.id, name: normalizeAccountName(row.name) });
    }
    const info = data.result_info;
    if (data.result.length === 0 || (info?.total_pages !== undefined && page >= info.total_pages) || (info?.total_count !== undefined && accounts.size >= info.total_count) || (!info?.total_pages && info?.total_count === undefined && data.result.length < (info?.per_page || 50))) return [...accounts.values()];
    if (before === accounts.size) throw new CloudflareError(502, 'Account pagination did not advance');
  }
  throw new CloudflareError(502, 'Account pagination limit exceeded');
}

export async function validateManualAccount(request: CfRequest, accountId: string): Promise<DiscoveredAccount> {
  if (typeof accountId !== 'string') throw Object.assign(new Error('Account ID must be a string'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  accountId = accountId.trim().toLowerCase();
  if (!/^[a-f\d]{32}$/i.test(accountId)) throw Object.assign(new Error('Account ID must contain 32 hexadecimal characters'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  try {
    const data = await request(`/accounts/${accountId}`);
    const account = data.result as DiscoveredAccount;
    if (account?.id !== accountId) throw new CloudflareError(502, 'Unexpected Account ID');
    return { id: account.id, name: normalizeAccountName(account.name || account.id) };
  } catch (error) {
    if (!['permission', 'invalid'].includes(errorDetails(error).kind)) throw error;
    // Scoped DNS/Workers/KV tokens may lack Account Settings:Read. Verify an actual scoped read.
    for (const path of [`/zones?account.id=${accountId}&per_page=50`, `/accounts/${accountId}/workers/scripts`, `/accounts/${accountId}/storage/kv/namespaces?per_page=1`]) {
      try {
        const data = await request(path);
        if (path.startsWith('/zones')) {
          const zone = (Array.isArray(data.result) ? data.result : []).find((z: { account?: DiscoveredAccount }) => z.account?.id === accountId);
          if (zone) return { id: accountId, name: normalizeAccountName(zone.account.name || accountId) };
        } else if (Array.isArray(data.result)) return { id: accountId, name: accountId };
      } catch (e) {
        if (!['permission', 'invalid'].includes(errorDetails(e).kind)) throw e;
      }
    }
    throw error;
  }
}

export async function discoverAccounts(request: CfRequest, authType: AuthInput['auth_type']): Promise<DiscoveryResult> {
  try {
    const accounts = await listAccessibleAccounts(request);
    return { status: accounts.length ? 'discovered' : 'manual_required', credentialStatus: 'active', accounts };
  } catch (error) {
    const details = errorDetails(error);
    if (!['invalid', 'permission'].includes(details.kind)) return { status: details.kind, credentialStatus: 'unknown', accounts: [], message: details.message };
    if (authType === 'token') {
      try {
        const verification = await request('/user/tokens/verify');
        const token = verification.result as { status?: string };
        if (token?.status === 'active') return { status: 'manual_required', credentialStatus: 'active', accounts: [], message: details.message };
        if (token?.status === 'disabled' || token?.status === 'expired') return { status: 'invalid', credentialStatus: 'invalid', accounts: [], message: `Token ${token.status}` };
      } catch (verifyError) {
        const verify = errorDetails(verifyError);
        if (verify.kind === 'invalid') return { status: 'invalid', credentialStatus: 'invalid', accounts: [], message: verify.message };
        if (!['permission', 'error'].includes(verify.kind)) return { status: verify.kind, credentialStatus: 'unknown', accounts: [], message: verify.message };
      }
    }
    // Enumeration or token verification permissions alone are not proof of an invalid credential.
    return { status: 'manual_required', credentialStatus: 'unknown', accounts: [], message: details.message };
  }
}
