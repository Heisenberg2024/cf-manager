import { getAllAccounts } from '../models/account';
import { accountRequest } from './cfFactory';
import { localSql } from './localSql';
import { dnsDirectory } from './dnsDirectory';
import { workerResources } from './workerResourcesRuntime';
import { tunnelResources } from './tunnelService';
import { storageResources, d1Resources } from './storageRuntime';
import type { DashboardRuntime } from './dashboardCollector';
export const dashboardRuntime:DashboardRuntime={db:localSql,accounts:async()=>getAllAccounts(),request:async a=>accountRequest(a as ReturnType<typeof getAllAccounts>[number]),zones:dnsDirectory,workers:workerResources,tunnels:tunnelResources,storage:storageResources,d1:d1Resources};
