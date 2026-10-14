import { boundedCatalogFetch, mapCatalogSources } from '../services/catalogReader';
import { catalogReader, CATALOG_URLS } from '../services/catalogRuntime';
import { mapConcurrent } from '../utils/concurrent';
import { errorDetails } from '../services/cfErrors';
import { Router, Request, Response, NextFunction } from 'express';
import {
  getCatalogSources, getEnabledCatalogSources, getCatalogSourceById,
  createCatalogSource, updateCatalogSource, deleteCatalogSource, ensureDefaultCatalogSource,
} from '../models/catalogSource';
import { validateCatalog, Catalog, CatalogTemplate } from '../services/catalogValidator';
import { deployTemplate, preflightDeploy } from '../services/catalogDeploy';
import { getAccountById } from '../models/account';
import { appLogger } from '../services/logger';
import { assertUrlSafe } from '../services/ssrfGuard';

// 主源用 surge.sh：Surge 静态托管，更新即时生效，避免 jsDelivr 缓存 GitHub 主分支导致更新延迟。
// 兜底顺序：surge.sh → jsDelivr → GitHub raw（GitHub raw 放最后，作为最终兜底）。
const DEFAULT_CATALOG_URL=CATALOG_URLS[0]!;
const DEFAULT_CATALOG_NAME = '官方源';

const router = Router();

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

async function testCatalogUrl(url: string): Promise<CatalogUrlTestResult> {
  try {
    const response=await boundedCatalogFetch(url,{safe:url=>assertUrlSafe(url),fetch:(url,init)=>fetch(url,init)});
    const json=JSON.parse(response.text);const result=validateCatalog(json);
    if(!result.valid)return {ok:false,errorCode:'INVALID_CATALOG',error:'Schema invalid'};
    return {ok:true,templateCount:json.templates.length,etag:response.etag,etagUrl:response.url,json};
  }catch(error){return {ok:false,errorCode:'FETCH_ERROR',error:(error as Error).message};}
}

router.get('/sources', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(getCatalogSources());
  } catch (err) { next(err); }
});

// 独立测试接口：验证 URL 是否可拉取且符合 catalog 格式（不落库）
router.post('/sources/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.body;
    const result = await testCatalogUrl(url);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, name } = req.body;
    if (!name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
      return;
    }
    const test = await testCatalogUrl(url);
    if (!test.ok) {
      res.status(400).json({ error: { code: test.errorCode || 'FETCH_ERROR', message: test.error } });
      return;
    }
    const id = createCatalogSource({ url, name });
    await catalogReader.seed({id,url},test.json as Catalog,test.etag??null,test.etagUrl??url);
    if (test.etag) updateCatalogSource(id, { etag: test.etag, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.put('/sources/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const source = getCatalogSourceById(id);
    if (!source) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source not found' } }); return; }
    const body = req.body;
    if (source.is_default && body.url && body.url !== source.url) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '默认源的 URL 不可修改' } });
      return;
    }
    if (body.url && body.url !== source.url) {
      const test=await testCatalogUrl(body.url);if(!test.ok){res.status(400).json({error:{code:test.errorCode,message:test.error}});return;}
      updateCatalogSource(id,{...body,etag:null});catalogReader.invalidate(id);await catalogReader.seed({...source,url:body.url},test.json,test.etag??null,test.etagUrl??body.url);
    } else updateCatalogSource(id,body);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/sources/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    deleteCatalogSource(id);
    catalogReader.invalidate(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ Catalog Fetch ============

async function fetchSourceCatalog(source:any):Promise<Catalog|null>{return (await catalogReader.read(source)).catalog;}
async function refreshSource(source:any):Promise<Catalog|null>{return (await catalogReader.read(source,{force:true})).catalog;}
// ============ Template List ============

router.get('/templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = getEnabledCatalogSources().filter(s=>!req.query.sourceId||s.id===Number(req.query.sourceId));
    const states=await mapCatalogSources(sources,s=>catalogReader.read(s,{cacheOnly:req.query.cacheOnly==='true'}));
    const results=states.map(r=>r.catalog);

    const seen = new Map<string, { template: CatalogTemplate; sourceId: number; sourceName: string; sourceCount: number }>();
    const idSources = new Map<string, number>();

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const catalog = results[i];
      if (!catalog?.templates) continue;
      for (const template of catalog.templates) {
        const count = idSources.get(template.id) || 0;
        idSources.set(template.id, count + 1);
        if (!seen.has(template.id)) {
          seen.set(template.id, { template, sourceId: source.id, sourceName: source.name, sourceCount: 0 });
        }
      }
    }
    for (const entry of seen.values()) {
      entry.sourceCount = idSources.get(entry.template.id) || 1;
    }
    res.json({ templates: Array.from(seen.values()), sources:sources.map((s,i)=>({...s,sync:{...states[i],catalog:undefined}})) });
  } catch (err) { next(err); }
});

// ============ Refresh ============

router.post('/refresh', async (req: Request,res: Response,next: NextFunction)=>{try{
    const sources=getEnabledCatalogSources().filter(s=>!req.body?.sourceId||s.id===Number(req.body.sourceId));
    const results=await mapCatalogSources(sources,async s=>{const r=await catalogReader.read(s,{force:true});return {id:s.id,name:s.name,success:!r.errorKind,state:r.state,errorKind:r.errorKind};});res.json(results);
  }catch(error){next(error);}});

// ============ Init ============

router.get('/init', (_req: Request, res: Response) => {
  ensureDefaultCatalogSource(DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME);
  res.json({ success: true });
});

// ============ Shared helper: find template from enabled sources ============

async function findTemplate(templateId: string): Promise<CatalogTemplate | null> {
  const sources = getEnabledCatalogSources();
  for (const source of sources) {
    const catalog = await fetchSourceCatalog(source);
    if (catalog?.templates) {
      const found = catalog.templates.find(t => t.id === templateId) || null;
      if (found) return found;
    }
  }
  return null;
}

// ============ Preflight (两阶段部署: 预检) ============

router.post('/preflight', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, templateId, name, bindingSelections, secretValues, deployType } = req.body;
    if (!accountId || !templateId || !name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } });
      return;
    }
    const account = getAccountById(parseInt(accountId, 10));
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }

    const template = await findTemplate(templateId);
    if (!template) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }); return; }

    const result = await preflightDeploy({
      account, template, name,
      bindingSelections: bindingSelections || {},
      secretValues: secretValues || {},
      deployType: deployType || undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Deploy (两阶段部署: 确认执行) ============

router.post('/deploy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, templateId, name, bindingSelections, secretValues, deployType, traces, logs } = req.body;
    if (!accountId || !templateId || !name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } });
      return;
    }
    const account = getAccountById(parseInt(accountId, 10));
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }

    const template = await findTemplate(templateId);
    if (!template) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }); return; }

    appLogger.info(`[Store] deploy: deploying for account ${account.name} (DB id=${account.id}, CF=${account.account_id})`);
    const result = await deployTemplate({
      account, template, name,
      bindingSelections: bindingSelections || {},
      secretValues: secretValues || {},
      deployType: deployType || undefined,
      traces: traces !== false,
      logs: logs !== false,
    });
    if (result.success) {
      res.json(result);
    } else {
      // 使用标准 error 格式，避免 responseWrapper 将 success:false 体的其余字段包装为 error 对象
      res.status(500).json({
        error: {
          code: 'DEPLOY_FAILED',
          message: result.error || '部署失败',
          rolledBack: result.rolledBack,
          rollbackErrors: result.rollbackErrors,
          warnings: result.warnings,
        },
      });
    }
  } catch (err) { next(err); }
});

// ============ Batch Deploy (多账户批量部署) ============

router.post('/deploy-batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deployments } = req.body;
    if (!Array.isArray(deployments) || deployments.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'deployments must be a non-empty array' } });
      return;
    }

    const firstDeployment = deployments[0];
    const template = await findTemplate(firstDeployment.templateId);
    if (!template) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }); return; }

    const results = await mapConcurrent(deployments, 3, async (d: any) => {
      try {
      const account = getAccountById(parseInt(d.accountId, 10));
      if (!account) return { accountId: d.accountId, name: d.name, success: false, error: 'Account not found' };

      // Preflight
      const pfResult = await preflightDeploy({
        account, template, name: d.name,
        bindingSelections: d.bindingSelections || {},
        secretValues: d.secretValues || {},
        deployType: d.deployType || undefined,
      });

      if (!pfResult.canProceed) {
        const pfErrors = pfResult.warnings?.join('; ') || '预检未通过';
        return { accountId: d.accountId, name: d.name, success: false, error: pfErrors };
      }

      // Deploy
      appLogger.info(`[Store] deploy-batch: deploying for account ${account.name} (DB id=${account.id}, CF=${account.account_id})`);
      const result = await deployTemplate({
        account, template, name: d.name,
        bindingSelections: d.bindingSelections || {},
        secretValues: d.secretValues || {},
        deployType: d.deployType || undefined,
        traces: d.traces !== false,
        logs: d.logs !== false,
      });

      return {
        accountId: d.accountId,
        accountName: account.name,
        cfAccountId: account.account_id,
        name: d.name,
        success: result.success,
        error: result.success ? undefined : (result.error || '部署失败'),
        warnings: result.warnings,
      };
      } catch (error) { return { accountId: d.accountId, name: d.name, success: false, error: errorDetails(error).message }; }
    });
    res.json(results);
  } catch (err) { next(err); }
});

export default router;
export { refreshSource as refreshCatalogSource, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME };
