import { describe, it, expect, vi } from 'vitest';
import { workerResourcesContract } from '../../shared/tests/workerResources.contract';
import { WorkerResources } from '../src/services/workerResources';
import { ZoneDirectory } from '../src/services/zoneDirectory';
import { accountZones, liveAccountZone } from '../src/services/accountZones';
workerResourcesContract('Docker', { WorkerResources, ZoneDirectory, accountZones, liveAccountZone }, { describe, it, expect, vi });
