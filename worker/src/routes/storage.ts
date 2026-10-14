import {recordInventoryList} from '../services/dashboardCollector';
import {localSql} from '../services/localSql';
import {getDnsDirectory} from '../services/dnsDirectory';
import { mapConcurrent } from '../utils/concurrent';
import { errorDetails } from '../services/cfErrors';
import { Hono } from 'hono';
import type { Env } from '../types';
import { getAccountById, addAuditLog } from '../db/models';
import { cfFetch, cfFetchRaw, accountRequest } from '../services/cfApi';
import { isDemoAccount, demoDestructiveGuard } from '../services/demo';

import {getStorageResources,getD1Resources} from '../services/storageRuntime';
import {pageOptions,requireStorageBinding} from '../services/storageResources';
const app = new Hono<{ Bindings: Env }>();

// 演示账户：拦截所有销毁/删除类操作（DELETE、bulk-delete）
app.use('/:accountId/*', demoDestructiveGuard());
app.use('*',async(c,next)=>{
  try{await next();}finally{
    c.header('Cache-Control','no-store');
    if(c.req.method!=='GET'){
      const account=await getAccountById(c.env.DB,Number(c.req.param('accountId')));
      if(account){if(c.req.path.includes('/d1')&&!c.req.path.endsWith('/query'))getD1Resources(c.env.DB).invalidate(account.id,account.account_id,c.req.param('dbId'));const kind=c.req.path.includes('/kv')?'kv':c.req.path.includes('/r2')?(c.req.param('bucket')?'objects':'buckets'):undefined;if(kind){getStorageResources(c.env.DB).invalidate(account.id,account.account_id,kind,c.req.param('nsId') || c.req.param('bucket') || '');if(kind==='objects'&&c.req.method==='DELETE'&&c.req.path.endsWith(`/r2/${c.req.param('bucket')}`))getStorageResources(c.env.DB).invalidate(account.id,account.account_id,'buckets','');}}
    }
  }
});

async function requireAccount(c: any) {
  const input=c.req.param('accountId');if(!/^\d+$/.test(input)||(!Number.isSafeInteger(Number(input))||Number(input)<=0))throw Object.assign(new Error('Invalid Account ID'),{statusCode:400});
  const id = Number(input);
  const account = await getAccountById(c.env.DB, id);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return requireStorageBinding(account);
}

const acctPath = (a: any) => `/accounts/${a.account_id}`;

// ============ KV Namespaces ============
app.get('/:accountId/kv', async (c) => {
  const account = await requireAccount(c);
  const started=Date.now();const result=await getDnsDirectory(c.env.DB).all(account,await accountRequest(account,c.env.ENCRYPTION_KEY),`${acctPath(account)}/storage/kv/namespaces`,50);
  await recordInventoryList(localSql(c.env.DB),account,'kv',result,started);return c.json(result);
});

app.post('/:accountId/kv', async (c) => {
  const account = await requireAccount(c);
  const { title } = await c.req.json();
  if (!title) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }, 400);
  const result = await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ title }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_kv', target: title, status: 'success' });
  return c.json(result, 201);
});

app.delete('/:accountId/kv/:nsId', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_kv', target: c.req.param('nsId'), status: 'success' });
  return c.json({ success: true });
});

app.get('/:accountId/kv/:nsId/keys', async (c) => {
  const account = await requireAccount(c);
  const page=await getStorageResources(c.env.DB).page(account,await accountRequest(account,c.env.ENCRYPTION_KEY),'kv',c.req.param('nsId'),{...pageOptions(c.req.query()),signal:c.req.raw.signal});
  return c.json({keys:page.items,cursor:page.cursor,is_truncated:page.is_truncated,meta:page.meta});
});

app.get('/:accountId/kv/:nsId/values/:key', async (c) => {
  const account = await requireAccount(c);
  const key = decodeURIComponent(c.req.param('key'));
  const resp = await cfFetchRaw(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/values/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY);
  const value = await resp.text();
  return c.json({ value, metadata: null });
});

app.put('/:accountId/kv/:nsId/values/:key', async (c) => {
  const account = await requireAccount(c);
  const key = decodeURIComponent(c.req.param('key'));
  const { value, metadata } = await c.req.json();
  const form = new FormData();
  form.append('value', value);
  if (metadata) form.append('metadata', JSON.stringify(metadata));
  await cfFetchRaw(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/values/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: form,
  });
  return c.json({ success: true });
});

app.delete('/:accountId/kv/:nsId/values/:key', async (c) => {
  const account = await requireAccount(c);
  const key = decodeURIComponent(c.req.param('key'));
  await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/values/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

app.post('/:accountId/kv/:nsId/bulk-delete', async (c) => {
  const account = await requireAccount(c);
  const { keys } = await c.req.json();
  if (!Array.isArray(keys)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'keys must be an array' } }, 400);
  await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/bulk`, c.env.ENCRYPTION_KEY, {
    method: 'DELETE', body: JSON.stringify(keys),
  });
  return c.json({ success: true });
});

// ============ D1 Databases ============
app.get('/:accountId/d1', async (c) => {
  const account = await requireAccount(c);
  return c.json(await getD1Resources(c.env.DB).databases(account,await accountRequest(account,c.env.ENCRYPTION_KEY),{refresh:c.req.query('refresh')==='true',signal:c.req.raw.signal}));
});

app.post('/:accountId/d1', async (c) => {
  const account = await requireAccount(c);
  const { name } = await c.req.json();
  if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  const result = await cfFetch(account, `${acctPath(account)}/d1/database`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ name }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_d1', target: name, status: 'success' });
  return c.json(result, 201);
});

app.delete('/:accountId/d1/:dbId', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `${acctPath(account)}/d1/database/${c.req.param('dbId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_d1', target: c.req.param('dbId'), status: 'success' });
  return c.json({ success: true });
});

app.get('/:accountId/d1/:dbId/tables', async (c) => {
  const account = await requireAccount(c);
  return c.json(await getD1Resources(c.env.DB).tables(account,await accountRequest(account,c.env.ENCRYPTION_KEY),c.req.param('dbId'),{refresh:c.req.query('refresh')==='true',signal:c.req.raw.signal}));
});

app.get('/:accountId/d1/:dbId/tables/:tableName/schema', async (c) => {
  const account = await requireAccount(c);
  return c.json(await getD1Resources(c.env.DB).schema(account,await accountRequest(account,c.env.ENCRYPTION_KEY),c.req.param('dbId'),c.req.param('tableName'),{refresh:c.req.query('refresh')==='true',signal:c.req.raw.signal}));
});

app.post('/:accountId/d1/:dbId/query', async (c) => {
  const account = await requireAccount(c);
  const body=await c.req.json();
  try{
    const {result,policy}=await getD1Resources(c.env.DB).execute(account,await accountRequest(account,c.env.ENCRYPTION_KEY),c.req.param('dbId'),body,isDemoAccount(account.id,c.env.DEMO_ACCOUNT_IDS),c.req.raw.signal);
    await addAuditLog(c.env.DB,{account_id:account.id,action:'d1_query',target:c.req.param('dbId'),detail:JSON.stringify({operation:policy.operation,readOnly:policy.readOnly,outcome:'confirmed',returnedRows:result.results.length}),status:'success'});return c.json(result);
  }catch(error:any){await addAuditLog(c.env.DB,{account_id:account.id,action:'d1_query',target:c.req.param('dbId'),detail:JSON.stringify({operation:error.operation || 'rejected',outcome:error.code==='D1_OUTCOME_UNCERTAIN'?'uncertain':'failed'}),status:'error'});throw error;}

});

app.get('/:accountId/d1/:dbId/tables/:tableName/data',async(c)=>{
 const account=await requireAccount(c);return c.json(await getD1Resources(c.env.DB).tablePage(account,await accountRequest(account,c.env.ENCRYPTION_KEY),c.req.param('dbId'),c.req.param('tableName'),{limit:c.req.query('limit'),cursor:c.req.query('cursor'),signal:c.req.raw.signal}));
});

// ============ R2 Buckets ============
app.get('/:accountId/r2', async (c) => {
  const account = await requireAccount(c);
  // 短路：缓存显示 R2 不可用则直接返回
  const r2Features = (account.available_features || '').split(',');
  if (r2Features.includes('-r2')) {
    return c.json({ success: false, error: { code: 'R2_NOT_ENABLED', message: 'R2 is not enabled for this account' } }, 403);
  }
  try {
    const runtime=getStorageResources(c.env.DB),request=await accountRequest(account,c.env.ENCRYPTION_KEY),options={...pageOptions(c.req.query()),signal:c.req.raw.signal};
    if(c.req.query('paged')==='true'||c.req.query('cursor')!==undefined){const page=await runtime.page(account,request,'buckets','',options);return c.json({buckets:page.items,cursor:page.cursor,is_truncated:page.is_truncated,meta:page.meta});}
    return c.json(await runtime.allBuckets(account,request,options));
  } catch (e: any) {
    if (/10042|enable R2/i.test(errorDetails(e).message)) {
      return c.json({ success: false, error: { code: 'R2_NOT_ENABLED', message: 'R2 is not enabled for this account' } }, 403);
    }
    throw e;
  }
});

app.post('/:accountId/r2', async (c) => {
  const account = await requireAccount(c);
  const { name } = await c.req.json();
  if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  const result = await cfFetch(account, `${acctPath(account)}/r2/buckets`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ name }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_r2', target: name, status: 'success' });
  return c.json(result, 201);
});

app.delete('/:accountId/r2/:bucket', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_r2', target: c.req.param('bucket'), status: 'success' });
  return c.json({ success: true });
});

app.get('/:accountId/r2/:bucket/objects', async (c) => {
  const account = await requireAccount(c);
  const page=await getStorageResources(c.env.DB).page(account,await accountRequest(account,c.env.ENCRYPTION_KEY),'objects',c.req.param('bucket'),{...pageOptions({...c.req.query(),delimiter:c.req.query('delimiter') ?? '/'}),signal:c.req.raw.signal});
  return c.json({objects:page.items,delimited_prefixes:page.prefixes,cursor:page.cursor,is_truncated:page.is_truncated,meta:page.meta});
});

app.delete('/:accountId/r2/:bucket/objects', async (c) => {
  const account = await requireAccount(c);
  const key = c.req.query('key');
  if (!key) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'key is required' } }, 400);
  await cfFetch(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

app.post('/:accountId/r2/:bucket/bulk-delete', async (c) => {
  const account = await requireAccount(c);
  const { keys } = await c.req.json();
  if (!Array.isArray(keys)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'keys must be an array' } }, 400);
  const results = await mapConcurrent(keys as string[], 3, async key => {
    try { await cfFetch(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' }); return { key, success: true }; }
    catch (error) { return { key, success: false, error: errorDetails(error).message }; }
  });
  return c.json({ success: true, total: results.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results });
});

app.get('/:accountId/r2/:bucket/download', async (c) => {
  const account = await requireAccount(c);
  const key = c.req.query('key');
  if (!key) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'object key is required (query param)' } }, 400);
  const resp = await cfFetchRaw(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY);
  if (!resp.ok) {
    const body = await resp.text();
    return c.json({ error: { code: 'R2_ERROR', message: body } }, resp.status as any);
  }
  const ct = resp.headers.get('content-type') || 'application/octet-stream';
  const inline = c.req.query('inline') === '1' || c.req.query('inline') === 'true';
  const filename = key.split('/').pop() || 'download';
  return new Response(resp.body, {
    headers: {
      'Content-Type': ct,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    },
  });
});

app.put('/:accountId/r2/:bucket/upload', async (c) => {
  const account = await requireAccount(c);
  const form = await c.req.formData();
  const key = form.get('key') as string;
  const file = form.get('file') as File | null;
  if (!key) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'key is required' } }, 400);
  if (!file) return c.json({ error: { code: 'NO_FILE', message: 'file is required' } }, 400);

  // 上传体积上限 50MB（P1-3：Worker 端缺乏请求体大小限制，易被滥用）
  const MAX_R2_UPLOAD = 50 * 1024 * 1024;
  const cl = parseInt(c.req.header('content-length') || '0', 10);
  if (cl > MAX_R2_UPLOAD) {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '上传体积超过 50MB 上限' } }, 413);
  }
  if (file.size > MAX_R2_UPLOAD) {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '上传体积超过 50MB 上限' } }, 413);
  }

  const buffer = await file.arrayBuffer();
  await cfFetchRaw(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': file.type || 'application/octet-stream' } as any,
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'r2_upload', target: `${c.req.param('bucket')}/${key}`, detail: `${buffer.byteLength} bytes`, status: 'success' });
  return c.json({ success: true });
});

export default app;
