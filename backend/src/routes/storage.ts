import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createAuditLog } from '../models/auditLog';
import { getAccountOr404 as baseGetAccount, demoDestructiveGuard, isDemoAccountId } from './routeUtils';
import {
  createKvNamespace, deleteKvNamespace, getKvValue, putKvValue, deleteKvKey, bulkDeleteKvKeys,
  createD1Database, deleteD1Database,
  createR2Bucket, deleteR2Bucket, getR2Object, putR2Object, deleteR2Object, bulkDeleteR2Objects,
} from '../services/storageService';
import { listKvNamespaces } from '../services/workerService';

import {storageResources,d1Resources} from '../services/storageRuntime';
import {accountRequest} from '../services/cfFactory';
import {pageOptions,requireStorageBinding} from '../services/storageResources';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

// 演示账户：拦截所有销毁/删除类操作（DELETE、bulk-delete）
router.use('/:accountId',demoDestructiveGuard);
function getAccountOr404(req:Request,res:Response){
 if(!/^\d+$/.test(String(req.params.accountId))||(!Number.isSafeInteger(Number(req.params.accountId))||Number(req.params.accountId)<=0))throw Object.assign(new Error('Invalid Account ID'),{statusCode:400});
 const account=baseGetAccount(req,res);return account?requireStorageBinding(account):null;
}
router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');const controller=new AbortController();res.locals.readSignal=controller.signal;res.on('close',()=>{if(!res.writableEnded)controller.abort();});next();});

function p(req: Request, key: string): string {
  return req.params[key] as string;
}

// ============ KV Namespaces ============

router.get('/:accountId/kv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await listKvNamespaces(account);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/:accountId/kv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { title } = req.body;
    if (!title) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }); return; }
    const result = await createKvNamespace(account,title).finally(()=>storageResources.invalidate(account.id,account.account_id,'kv',''));
    createAuditLog(account.id, 'kv_create_ns', title, null, 'success');
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/kv/:nsId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    try { await deleteKvNamespace(account, p(req, 'nsId')); } finally {storageResources.invalidate(account.id,account.account_id,'kv',p(req,'nsId'));}
    createAuditLog(account.id, 'kv_delete_ns', p(req, 'nsId'), null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:accountId/kv/:nsId/keys', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const page=await storageResources.page(account,accountRequest(account),'kv',p(req,'nsId'),{...pageOptions(req.query),signal:res.locals.readSignal});
    const result={keys:page.items,cursor:page.cursor,is_truncated:page.is_truncated,meta:page.meta};
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:accountId/kv/:nsId/values/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await getKvValue(account, p(req, 'nsId'), p(req, 'key'));
    res.json(result);
  } catch (err) { next(err); }
});

router.put('/:accountId/kv/:nsId/values/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { value, expiration, expiration_ttl, metadata } = req.body;
    try { await putKvValue(account, p(req, 'nsId'), p(req, 'key'), value, { expiration, expiration_ttl, metadata }); } finally {storageResources.invalidate(account.id,account.account_id,'kv',p(req,'nsId'));}
    createAuditLog(account.id, 'kv_write', `${p(req, 'nsId')}/${p(req, 'key')}`, null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:accountId/kv/:nsId/values/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    try { await deleteKvKey(account, p(req, 'nsId'), p(req, 'key')); } finally {storageResources.invalidate(account.id,account.account_id,'kv',p(req,'nsId'));}
    createAuditLog(account.id, 'kv_delete', `${p(req, 'nsId')}/${p(req, 'key')}`, null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:accountId/kv/:nsId/bulk-delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { keys } = req.body;
    if (!Array.isArray(keys)) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'keys must be an array' } }); return; }
    try { await bulkDeleteKvKeys(account, p(req, 'nsId'), keys); } finally {storageResources.invalidate(account.id,account.account_id,'kv',p(req,'nsId'));}
    createAuditLog(account.id, 'kv_bulk_delete', p(req, 'nsId'), `${keys.length} keys`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ D1 ============

router.get('/:accountId/d1', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await d1Resources.databases(account,accountRequest(account),{refresh:req.query.refresh==='true',signal:res.locals.readSignal});
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/:accountId/d1', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }); return; }
    const result = await createD1Database(account,name).finally(()=>d1Resources.invalidate(account.id,account.account_id));
    createAuditLog(account.id, 'd1_create_db', name, null, 'success');
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/d1/:dbId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    try{await deleteD1Database(account,p(req,'dbId'));}finally{d1Resources.invalidate(account.id,account.account_id,p(req,'dbId'));}
    createAuditLog(account.id, 'd1_delete_db', p(req, 'dbId'), null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:accountId/d1/:dbId/tables', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const tables = await d1Resources.tables(account,accountRequest(account),p(req,'dbId'),{refresh:req.query.refresh==='true',signal:res.locals.readSignal});
    res.json(tables);
  } catch (err) { next(err); }
});

router.get('/:accountId/d1/:dbId/tables/:tableName/schema', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const schema = await d1Resources.schema(account,accountRequest(account),p(req,'dbId'),p(req,'tableName'),{refresh:req.query.refresh==='true',signal:res.locals.readSignal});
    res.json(schema);
  } catch (err) { next(err); }
});

router.post('/:accountId/d1/:dbId/query', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    try{
      const {result,policy}=await d1Resources.execute(account,accountRequest(account),p(req,'dbId'),req.body,isDemoAccountId(account.id),res.locals.readSignal);
      createAuditLog(account.id,'d1_query',p(req,'dbId'),JSON.stringify({operation:policy.operation,readOnly:policy.readOnly,outcome:'confirmed',returnedRows:result.results.length}),'success');res.json(result);
    }catch(error:any){createAuditLog(account.id,'d1_query',p(req,'dbId'),JSON.stringify({operation:error.operation || 'rejected',outcome:error.code==='D1_OUTCOME_UNCERTAIN'?'uncertain':'failed'}),'error');throw error;}
  } catch (err) { next(err); }
});

router.get('/:accountId/d1/:dbId/tables/:tableName/data',async(req,res,next)=>{
 try{const account=getAccountOr404(req,res);if(!account)return;res.json(await d1Resources.tablePage(account,accountRequest(account),p(req,'dbId'),p(req,'tableName'),{limit:req.query.limit,cursor:req.query.cursor,signal:res.locals.readSignal}));}catch(error){next(error);}
});

// ============ R2 ============

router.get('/:accountId/r2', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    // 短路：缓存显示 R2 不可用则直接返回
    const r2Features = (account.available_features || '').split(',');
    if (r2Features.includes('-r2')) {
      res.status(403).json({ success: false, error: { code: 'R2_NOT_ENABLED', message: 'R2 is not enabled for this account' } });
      return;
    }
    if(req.query.paged==='true'||req.query.cursor!==undefined){const page=await storageResources.page(account,accountRequest(account),'buckets','',{...pageOptions(req.query),signal:res.locals.readSignal});res.json({buckets:page.items,cursor:page.cursor,is_truncated:page.is_truncated,meta:page.meta});return;}
    const result=await storageResources.allBuckets(account,accountRequest(account),{...pageOptions(req.query),signal:res.locals.readSignal});
    res.json(result);
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('10042') || msg.includes('Please enable R2')) {
      res.status(403).json({ success: false, error: { code: 'R2_NOT_ENABLED', message: 'R2 is not enabled for this account' } });
      return;
    }
    next(err);
  }
});

router.post('/:accountId/r2', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }); return; }
    const result = await createR2Bucket(account,name).finally(()=>storageResources.invalidate(account.id,account.account_id,'buckets',''));
    createAuditLog(account.id, 'r2_create_bucket', name, null, 'success');
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/r2/:bucket', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    try { await deleteR2Bucket(account, p(req, 'bucket')); } finally {storageResources.invalidate(account.id,account.account_id,'buckets','');storageResources.invalidate(account.id,account.account_id,'objects',p(req,'bucket'));}
    createAuditLog(account.id, 'r2_delete_bucket', p(req, 'bucket'), null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:accountId/r2/:bucket/objects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const page=await storageResources.page(account,accountRequest(account),'objects',p(req,'bucket'),{...pageOptions({...req.query,delimiter:req.query.delimiter ?? '/'}),signal:res.locals.readSignal});
    const result={objects:page.items,delimited_prefixes:page.prefixes,cursor:page.cursor,is_truncated:page.is_truncated,meta:page.meta};
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:accountId/r2/:bucket/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const key = req.query.key as string;
    if (!key) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'object key is required (query param)' } }); return; }
    const objResp = await getR2Object(account, p(req, 'bucket'), key);
    const ct = objResp.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    const cl = objResp.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const inline = req.query.inline === '1' || req.query.inline === 'true';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${key.split('/').pop()}"`);
    const body = objResp.body as any;
    if (body) {
      if (typeof body.getReader === 'function') {
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } else if (typeof body.pipe === 'function') {
        await new Promise<void>((resolve, reject) => {
          body.pipe(res, { end: false });
          body.on('end', resolve);
          body.on('error', reject);
        });
      }
    }
    res.end();
  } catch (err) { next(err); }
});

router.put('/:accountId/r2/:bucket/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const key = req.body.key as string;
    if (!key) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'key is required' } }); return; }
    if (!req.file) { res.status(400).json({ error: { code: 'NO_FILE', message: 'file is required' } }); return; }
    try { await putR2Object(account, p(req, 'bucket'), key, req.file.buffer, req.file.mimetype); } finally {storageResources.invalidate(account.id,account.account_id,'objects',p(req,'bucket'));}
    createAuditLog(account.id, 'r2_upload', `${p(req, 'bucket')}/${key}`, `${req.file.size} bytes`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:accountId/r2/:bucket/objects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const key = req.query.key as string;
    if (!key) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'object key is required (query param)' } }); return; }
    try { await deleteR2Object(account, p(req, 'bucket'), key); } finally {storageResources.invalidate(account.id,account.account_id,'objects',p(req,'bucket'));}
    createAuditLog(account.id, 'r2_delete', `${p(req, 'bucket')}/${key}`, null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:accountId/r2/:bucket/bulk-delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { keys } = req.body;
    if (!Array.isArray(keys)) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'keys must be an array' } }); return; }
    const results = await bulkDeleteR2Objects(account, p(req, 'bucket'), keys);
    storageResources.invalidate(account.id,account.account_id,'objects',p(req,'bucket'));
    createAuditLog(account.id, 'r2_bulk_delete', p(req, 'bucket'), `${keys.length} objects`, 'success');
    res.json({ success: true, total: results.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results });
  } catch (err) { next(err); }
});

export default router;
