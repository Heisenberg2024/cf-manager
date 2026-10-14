import { getAllAccounts, type Account } from '../db/models';
import { accountRequest } from './cfApi';
import { localSql } from './localSql';
import { getDnsDirectory } from './dnsDirectory';
import { getWorkerResources } from './workerResourcesRuntime';
import { getTunnelResources } from './tunnelService';
import { getStorageResources, getD1Resources } from './storageRuntime';
import type { DashboardRuntime } from './dashboardCollector';
import type { Env } from '../types';
export function dashboardRuntime(env:Env):DashboardRuntime{return {db:localSql(env.DB),accounts:()=>getAllAccounts(env.DB),request:a=>accountRequest(a as Account,env.ENCRYPTION_KEY),zones:getDnsDirectory(env.DB),workers:getWorkerResources(env.DB),tunnels:getTunnelResources(env.DB),storage:getStorageResources(env.DB),d1:getD1Resources(env.DB)};}
