import { Account } from '../models/account';
import { getCfClient, accountRequest } from './cfFactory';
import { appLogger } from './logger';
import { accountZones, liveAccountZone } from './accountZones';
import { dnsDirectory } from './dnsDirectory';

export interface PagesProject {
  id: string;
  name: string;
  subdomain: string;
  domains: string[];
  created_on: string;
  production_branch: string;
  deployment_count: number;
  source?: { type: string };
}

// 确保 Pages 项目存在，已存在时忽略 409 错误
export async function ensurePagesProject(account: Account, projectName: string): Promise<void> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const cf = getCfClient(account);
  try {
    await cf.pages.projects.create({ account_id: accountId, name: projectName, production_branch: 'main' } as any);
  } catch (e: any) {
    if (e?.status !== 409) throw e; // 409 = already exists, ignore
  }
}

// Pages 项目名称校验：Cloudflare 要求 ^[a-z0-9][a-z0-9-]*$
export function validatePagesProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}
export async function listPages(account: Account): Promise<PagesProject[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const projects: PagesProject[] = [];
  for await (const project of cf.pages.projects.list({ account_id: accountId })) {
    projects.push(project as any);
  }
  return projects;
}

export async function deletePagesProject(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.pages.projects.delete(name, { account_id: accountId! } as any);
}

export async function getPagesProject(account: Account, projectName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.get(projectName, { account_id: accountId! });
}

export async function editPagesProject(account: Account, projectName: string, params: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.edit(projectName, { ...params, account_id: accountId! });
}

export async function listPagesDomains(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  for await (const d of cf.pages.projects.domains.list(projectName, { account_id: accountId! })) {
    domains.push(d);
  }
  return domains;
}

export async function addPagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Get Pages project info to find the real subdomain
  let pagesSubdomain: string;
  try {
    const projectInfo = await cf.pages.projects.get(projectName, { account_id: accountId! }) as any;
    // Real subdomain format: {projectName}.{accountSubdomain}.pages.dev
    pagesSubdomain = projectInfo.subdomain || `${projectName}.pages.dev`;
    appLogger.info(`[Pages Domain] Real subdomain: ${pagesSubdomain}`);
  } catch (_e) {
    // Fallback to old format if API fails
    pagesSubdomain = `${projectName}.pages.dev`;
    appLogger.warn(`[Pages Domain] Failed to get project info, using fallback: ${pagesSubdomain}`);
  }

  // 2. Create the Pages domain association
  const result = await cf.pages.projects.domains.create(projectName, { account_id: accountId!, name: hostname });

  // 3. Automatically create CNAME DNS record if zone is in the same account
  try {
    const zones = await accountZones(dnsDirectory, account, accountRequest(account));
    const matchingZone = zones.filter(z => hostname.endsWith('.' + z.name) || hostname === z.name).sort((a,b) => b.name.length - a.name.length)[0];

    if (matchingZone) {
      await liveAccountZone(dnsDirectory, account, accountRequest(account), matchingZone.id);
      const existing: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        existing.push(r);
      }

      if (existing.length === 0) {
        await getCfClient(account, 0).dns.records.create({
          zone_id: matchingZone.id,
          type: 'CNAME',
          name: hostname,
          content: pagesSubdomain,
          proxied: true,
          ttl: 1,
        } as any);
        appLogger.info(`[Pages Domain] Created CNAME: ${hostname} → ${pagesSubdomain} (proxied)`);
      } else {
        appLogger.info(`[Pages Domain] CNAME already exists for ${hostname}, skipping`);
      }
    } else {
      appLogger.info(`[Pages Domain] No matching zone found for ${hostname}, skipping CNAME creation`);
    }
  } catch (dnsErr) {
    appLogger.error(`[Pages Domain] Failed to auto-create DNS record: ${dnsErr}`);
  }

  return result;
}

export async function removePagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Remove the Pages domain association
  const result = await cf.pages.projects.domains.delete(projectName, hostname, { account_id: accountId! });

  // 2. Clean up CNAME DNS record
  try {
    const zones = await accountZones(dnsDirectory, account, accountRequest(account));
    const matchingZone = zones.filter(z => hostname.endsWith('.' + z.name) || hostname === z.name).sort((a,b) => b.name.length - a.name.length)[0];
    if (matchingZone) {
      await liveAccountZone(dnsDirectory, account, accountRequest(account), matchingZone.id);
      const records: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        records.push(r);
      }
      for (const r of records) {
        if (r.content?.endsWith('.pages.dev')) {
          await getCfClient(account, 0).dns.records.delete(r.id, { zone_id: matchingZone.id });
          appLogger.info(`[Pages Domain] Deleted CNAME: ${hostname} → ${r.content}`);
        }
      }
    }
  } catch (dnsErr) {
    appLogger.error(`[Pages Domain] Failed to delete DNS record: ${dnsErr}`);
  }

  return result;
}

export async function listPagesDeployments(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const deps: any[] = [];
  for await (const d of cf.pages.projects.deployments.list(projectName, { account_id: accountId! })) {
    deps.push(d);
  }
  return deps;
}

export async function deletePagesDeployment(
  account: Account,
  projectName: string,
  deploymentId: string
): Promise<{ success: boolean; error?: string }> {
  const cf = getCfClient(account);
  try {
    await cf.pages.projects.deployments.delete(projectName, deploymentId, {
      account_id: account.account_id!,
    });
    return { success: true };
  } catch (err: any) {
    appLogger.error(`[Pages Deployment] Delete failed: ${deploymentId} — ${err?.message || err}`);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * 批量删除 Pages 部署记录（受控并发，最多 3 条并行）
 */
export async function batchDeletePagesDeployments(
  account: Account,
  projectName: string,
  ids: string[]
): Promise<{ total: number; succeeded: number; failed: number; results: Array<{ id: string; success: boolean; error?: string }> }> {
  const CONCURRENCY = 3;
  const results: Array<{ id: string; success: boolean; error?: string }> = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(id => deletePagesDeployment(account, projectName, id))
    );
    batchResults.forEach((r, j) => {
      if (r.status === 'fulfilled') {
        results.push({ id: batch[j], ...r.value });
      } else {
        results.push({ id: batch[j], success: false, error: String(r.reason) });
      }
    });
  }

  const succeeded = results.filter(r => r.success).length;
  return { total: ids.length, succeeded, failed: ids.length - succeeded, results };
}

export async function updatePagesBindings(account: Account, projectName: string, deploymentConfigs: any): Promise<any> {
  return await editPagesProject(account, projectName, { deployment_configs: deploymentConfigs });
}
