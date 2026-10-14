import { boundedCatalogFetch, mapCatalogSources } from '../services/catalogReader';
import { getCatalogReader, CATALOG_URLS } from '../services/catalogRuntime';
import { mapConcurrent } from '../utils/concurrent';
import { errorDetails } from '../services/cfErrors';
import { Hono } from 'hono';
import type { Env } from '../types';
import {
  getCatalogSources, getEnabledCatalogSources, getCatalogSourceById,
  createCatalogSource, updateCatalogSource, deleteCatalogSource,
  ensureDefaultCatalogSource,
} from '../db/models';
import { validateCatalog, type Catalog, type CatalogTemplate } from '../services/catalogValidator';
import { deployTemplate, preflightDeploy } from '../services/catalogDeploy';
import { getAccountById } from '../db/models';
import { assertUrlSafe } from '../services/ssrfGuard';

const app = new Hono<{ Bindings: Env }>();

// 主源用 surge.sh：Surge 静态托管，更新即时生效，避免 jsDelivr 缓存 GitHub 主分支导致更新延迟。
// 兜底顺序：surge.sh → jsDelivr → GitHub raw（GitHub raw 放最后，作为最终兜底）。
const DEFAULT_CATALOG_URL=CATALOG_URLS[0]!;
const DEFAULT_CATALOG_NAME = '官方源';

// ============ Source CRUD ============

// 校验某个 URL 是否为可拉取且格式合法的 catalog（供"添加源"创建前校验与独立测试复用）
interface CatalogUrlTestResult {
  ok: boolean;
  status?: number;
  templateCount?: number;
  errorCode?: string;
  error?: string;
  etag?: string | null;
  etagUrl?: string;
  json?: any;
}

async function testCatalogUrl(url: string, env?: Env): Promise<CatalogUrlTestResult> {
  try {
    const response=await boundedCatalogFetch(url,{safe:url=>assertUrlSafe(url, env),fetch:(url,init)=>fetch(url,init)});
    const json=JSON.parse(response.text);const result=validateCatalog(json);
    if(!result.valid)return {ok:false,errorCode:'INVALID_CATALOG',error:'Schema invalid'};
    return {ok:true,templateCount:json.templates.length,etag:response.etag,etagUrl:response.url,json};
  }catch(error){return {ok:false,errorCode:'FETCH_ERROR',error:(error as Error).message};}
}

app.get('/sources', async (c) => {
  const sources = await getCatalogSources(c.env.DB);
  return c.json(sources);
});

// 独立测试接口：验证 URL 是否可拉取且符合 catalog 格式（不落库）
app.post('/sources/test', async (c) => {
  const { url } = await c.req.json();
  const result = await testCatalogUrl(url,c.env);
  return c.json(result);
});

app.post('/sources', async (c) => {
  const { url, name } = await c.req.json();
  if (!name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  }

  // Fetch and validate before saving
  const test = await testCatalogUrl(url,c.env);
  if (!test.ok) {
    return c.json({ error: { code: test.errorCode || 'FETCH_ERROR', message: test.error } }, 400);
  }
  const id = await createCatalogSource(c.env.DB, { url, name });
  await getCatalogReader(c.env).seed({id,url},test.json,test.etag??null,test.etagUrl??url);
  return c.json({ id }, 201);
});

app.put('/sources/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const source = await getCatalogSourceById(c.env.DB, id);
  if (!source) return c.json({ error: { code: 'NOT_FOUND', message: 'Source not found' } }, 404);

  const body = await c.req.json();
  if (source.is_default && body.url && body.url !== source.url) {
    return c.json({ error: { code: 'FORBIDDEN', message: '默认源的 URL 不可修改' } }, 403);
  }

  if(body.url&&body.url!==source.url){const test=await testCatalogUrl(body.url,c.env);if(!test.ok)return c.json({error:{code:test.errorCode,message:test.error}},400);
    await updateCatalogSource(c.env.DB,id,{...body,etag:null});getCatalogReader(c.env).invalidate(id);await getCatalogReader(c.env).seed({...source,url:body.url},test.json,test.etag??null,test.etagUrl??body.url);
  }else await updateCatalogSource(c.env.DB,id,body);
  return c.json({ success: true });
});

app.delete('/sources/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await deleteCatalogSource(c.env.DB, id);
  getCatalogReader(c.env).invalidate(id);
  if (c.env.KV) await c.env.KV.delete(`catalog:${id}`);
  return c.json({ success: true });
});

// ============ Catalog Fetch ============

// 官方默认源启用 fallback 链；用户自定义源只使用自己的 url
async function fetchSourceCatalog(c:any,source:any):Promise<Catalog|null>{return (await getCatalogReader(c.env).read(source,{waitUntil:p=>c.executionCtx?.waitUntil(p)})).catalog;}
// ============ Template List (merged + dedup) ============

app.get('/templates', async (c) => {
  const sources=(await getEnabledCatalogSources(c.env.DB)).filter(s=>!c.req.query('sourceId')||s.id===Number(c.req.query('sourceId')));
  const states=await mapCatalogSources(sources,s=>getCatalogReader(c.env).read(s,{cacheOnly:c.req.query('cacheOnly')==='true',waitUntil:p=>c.executionCtx.waitUntil(p)}));
  const results=states.map(r=>r.catalog);

  // Dedup by id, priority: default source first, then by id ASC
  const seen = new Map<string, { template: CatalogTemplate; sourceId: number; sourceName: string; sourceCount: number }>();
  const idSources = new Map<string, number>();

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const catalog = results[i];
    if (!catalog || !catalog.templates) continue;

    for (const template of catalog.templates) {
      const existing = idSources.get(template.id) || 0;
      idSources.set(template.id, existing + 1);

      if (!seen.has(template.id)) {
        seen.set(template.id, {
          template, sourceId: source.id, sourceName: source.name, sourceCount: 0,
        });
      }
    }
  }

  // Update source counts
  for (const entry of seen.values()) {
    entry.sourceCount = idSources.get(entry.template.id) || 1;
  }

  const templates = Array.from(seen.values());
  return c.json({ templates, sources:sources.map((s,i)=>({...s,sync:{...states[i],catalog:undefined}})) });
});

// ============ Force Refresh ============

app.post('/refresh',async c=>{const body=await c.req.json().catch(()=>({}));const sources=(await getEnabledCatalogSources(c.env.DB)).filter(s=>!body.sourceId||s.id===Number(body.sourceId));
  const results=await mapCatalogSources(sources,async s=>{const r=await getCatalogReader(c.env).read(s,{force:true});return {id:s.id,name:s.name,success:!r.errorKind,state:r.state,errorKind:r.errorKind};});return c.json(results);
});

// ============ Init default source ============

app.get('/init', async (c) => {
  await ensureDefaultCatalogSource(c.env.DB, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME);
  return c.json({ success: true });
});

// ============ Shared helper: find template from enabled sources ============

async function findTemplate(c: any, templateId: string): Promise<CatalogTemplate | null> {
  const sources = await getEnabledCatalogSources(c.env.DB);
  for (const source of sources) {
    const catalog = await fetchSourceCatalog(c, source);
    if (catalog?.templates) {
      const found = catalog.templates.find(t => t.id === templateId) || null;
      if (found) return found;
    }
  }
  return null;
}

// ============ Preflight (两阶段部署: 预检) ============

app.post('/preflight', async (c) => {
  const body = await c.req.json();
  const { accountId, templateId, name, bindingSelections, secretValues, deployType } = body;

  if (!accountId || !templateId || !name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } }, 400);
  }

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const template = await findTemplate(c, templateId);
  if (!template) return c.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, 404);

  const result = await preflightDeploy({
    account, encryptionKey: c.env.ENCRYPTION_KEY, template, name,
    bindingSelections: bindingSelections || {},
    secretValues: secretValues || {},
    deployType: deployType || undefined,
  });

  return c.json(result, 200);
});

// ============ Deploy (两阶段部署: 确认执行) ============

app.post('/deploy', async (c) => {
  const body = await c.req.json();
  const { accountId, templateId, name, bindingSelections, secretValues, deployType, traces, logs } = body;

  if (!accountId || !templateId || !name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } }, 400);
  }

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const template = await findTemplate(c, templateId);
  if (!template) return c.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, 404);

  console.log(`[Store] deploy: deploying for account ${account.name} (DB id=${account.id}, CF=${account.account_id})`);
  const result = await deployTemplate({
    account, encryptionKey: c.env.ENCRYPTION_KEY, template, name,
    bindingSelections: bindingSelections || {}, secretValues: secretValues || {},
    deployType: deployType || undefined,
    traces: traces !== false,
    logs: logs !== false,
    db: c.env.DB,
  });

  if (result.success) {
    return c.json(result, 200);
  } else {
    return c.json({
      error: {
        code: 'DEPLOY_FAILED',
        message: result.error || '部署失败',
        rolledBack: result.rolledBack,
        rollbackErrors: result.rollbackErrors,
        warnings: result.warnings,
      },
    }, 500);
  }
});

// ============ Batch Deploy (多账户批量部署) ============

app.post('/deploy-batch', async (c) => {
  const body = await c.req.json();
  const { deployments } = body;

  if (!Array.isArray(deployments) || deployments.length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'deployments must be a non-empty array' } }, 400);
  }

  const firstDeployment = deployments[0];
  const template = await findTemplate(c, firstDeployment.templateId);
  if (!template) return c.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, 404);

  const results = await mapConcurrent(deployments, 3, async (d: any) => {
    try {
      const account = await getAccountById(c.env.DB, d.accountId);
      if (!account) return { accountId: d.accountId, name: d.name, success: false, error: 'Account not found' };

      // Preflight
      const pfResult = await preflightDeploy({
        account, encryptionKey: c.env.ENCRYPTION_KEY, template, name: d.name,
        bindingSelections: d.bindingSelections || {},
        secretValues: d.secretValues || {},
        deployType: d.deployType || undefined,
      });

      if (!pfResult.canProceed) {
        const pfErrors = pfResult.warnings?.join('; ') || '预检未通过';
        return { accountId: d.accountId, name: d.name, success: false, error: pfErrors };
      }

      // Deploy
      console.log(`[Store] deploy-batch: deploying for account ${account.name} (DB id=${account.id}, CF=${account.account_id})`);
      const result = await deployTemplate({
        account, encryptionKey: c.env.ENCRYPTION_KEY, template, name: d.name,
        bindingSelections: d.bindingSelections || {}, secretValues: d.secretValues || {},
        deployType: d.deployType || undefined,
        traces: d.traces !== false, logs: d.logs !== false,
        db: c.env.DB,
      });

      return {
        accountId: d.accountId, accountName: account.name, cfAccountId: account.account_id,
        name: d.name,
        success: result.success,
        error: result.success ? undefined : (result.error || '部署失败'),
        warnings: result.warnings,
      };
    } catch (e: any) {
      return { accountId: d.accountId, name: d.name, success: false, error: errorDetails(e).message };
    }
  });

  return c.json(results, 200);
});

export default app;
export { fetchSourceCatalog, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME };
