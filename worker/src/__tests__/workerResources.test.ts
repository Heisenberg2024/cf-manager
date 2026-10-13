import { describe, it, expect, vi } from 'vitest';
import { workerResourcesContract } from '../../../shared/tests/workerResources.contract';
import { WorkerResources } from '../services/workerResources';
import { ZoneDirectory } from '../services/zoneDirectory';
import { accountZones, liveAccountZone } from '../services/accountZones';
workerResourcesContract('Worker', { WorkerResources, ZoneDirectory, accountZones, liveAccountZone }, { describe, it, expect, vi });
