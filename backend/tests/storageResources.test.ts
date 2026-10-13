import {describe,it,expect,vi} from 'vitest';
import {storageResourcesContract} from '../../shared/tests/storageResources.contract';
import {StorageResources,normalizeStoragePage,pageOptions} from '../src/services/storageResources';
import {ZoneDirectory} from '../src/services/zoneDirectory';
storageResourcesContract('Docker',{StorageResources,normalizeStoragePage,pageOptions,ZoneDirectory},{describe,it,expect,vi});
