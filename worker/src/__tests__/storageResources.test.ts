import {describe,it,expect,vi} from 'vitest';
import {storageResourcesContract} from '../../../shared/tests/storageResources.contract';
import {StorageResources,normalizeStoragePage,pageOptions} from '../services/storageResources';
import {ZoneDirectory} from '../services/zoneDirectory';
storageResourcesContract('Worker',{StorageResources,normalizeStoragePage,pageOptions,ZoneDirectory},{describe,it,expect,vi});
