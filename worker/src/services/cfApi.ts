import type { Account } from '../db/models';
import { decrypt, DecryptError } from './encryption';
import { logger } from './logger';
import { createCfRequest, authHeaders, type AuthInput, type CfRequest } from './accountDiscovery';
import { redact } from './cfErrors';

export class CfApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(redact(`CF API error ${status}: ${body}`));
    this.status = status;
    this.body = redact(body);
  }
}

/** 错误提示里用的账号标识：让用户在几十个账号里知道是哪一个坏了。 */
function accountLabel(account: Account): string {
  return account.name ? `${account.name} (ID ${account.id})` : `ID ${account.id}`;
}

/**
 * 解密账号凭据。解密失败时补上账号标识后继续抛 DecryptError，
 * 让上层（errorHandler / 前端提示）能直接告诉用户「哪个账号、该怎么办」。
 */
async function decryptCredential(value: string, encryptionKey: string, account: Account): Promise<string> {
  try {
    return await decrypt(value, encryptionKey);
  } catch (err) {
    if (err instanceof DecryptError) throw new DecryptError(accountLabel(account), err);
    throw err;
  }
}

export async function getAuthHeaders(account: Account, encryptionKey: string): Promise<Record<string, string>> {
  if (account.is_enabled === 0) throw Object.assign(new Error(`Account ${account.name} (${account.account_id}) is disabled`), { statusCode: 409, code: 'ACCOUNT_DISABLED' });
  if (account.auth_type === 'token') {
    if (!account.api_token) throw new Error(`Account ${account.id} missing api_token`);
    const token = await decryptCredential(account.api_token, encryptionKey, account);
    return { Authorization: `Bearer ${token}` };
  }
  if (!account.api_key) throw new Error(`Account ${account.id} missing api_key`);
  if (!account.email) throw new Error(`Account ${account.id} missing email`);
  const apiKey = await decryptCredential(account.api_key, encryptionKey, account);
  return { 'X-Auth-Email': account.email, 'X-Auth-Key': apiKey };
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export function credentialRequest(input: AuthInput): CfRequest {
  return createCfRequest((path, init) => fetch(`${CF_BASE}${path}`, { ...init, signal: AbortSignal.timeout(15000) }), authHeaders(input), 'Credential');
}

export async function accountRequest(account: Account, encryptionKey: string): Promise<CfRequest> {
  return createCfRequest((path, init) => fetch(`${CF_BASE}${path}`, { ...init, signal: AbortSignal.timeout(15000) }), await getAuthHeaders(account, encryptionKey), `Account ${account.name} (${account.account_id})`);
}

export async function cfFetch<T = any>(
  account: Account,
  path: string,
  encryptionKey: string,
  init?: RequestInit
): Promise<T> {
  const request = await accountRequest(account, encryptionKey);
  return await request(path, init) as T;
}

export async function cfFetchRaw(
  account: Account,
  path: string,
  encryptionKey: string,
  init?: RequestInit
): Promise<Response> {
  const headers = await getAuthHeaders(account, encryptionKey);
  return fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> || {}) },
  });
}

export async function cfGraphQL(
  account: Account,
  query: string,
  variables: Record<string, unknown>,
  encryptionKey: string
): Promise<any> {
  const headers = await getAuthHeaders(account, encryptionKey);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  let resp: Response;
  try {
    resp = await fetch(`${CF_BASE}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new CfApiError(resp.status, body);
  }
  const json = await resp.json() as any;
  if (json.errors?.length) {
    const msg = `GraphQL errors for account ${account.id} (${account.name}): ${JSON.stringify(json.errors)}`;
    logger.error('cfApi', msg);
    throw new Error(msg);
  }
  return json;
}

interface CfListResponse<T> {
  result: T[];
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

export async function cfFetchAll<T>(
  account: Account,
  path: string,
  encryptionKey: string,
  perPage = 50
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (page <= 1000) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await cfFetch<CfListResponse<T>>(account, `${path}${sep}page=${page}&per_page=${perPage}`, encryptionKey);
    if (!Array.isArray(data.result)) throw new CfApiError(502, 'Unexpected paginated list response');
    all.push(...data.result);
    const info = data.result_info;
    if (data.result.length === 0 || (info?.total_pages !== undefined && page >= info.total_pages) || (info?.total_count !== undefined && all.length >= info.total_count) || (info?.total_pages === undefined && info?.total_count === undefined && data.result.length < (info?.per_page || perPage))) return all;
    page++;
  }
  throw new CfApiError(502, 'Cloudflare list pagination exceeded its limit');
}
