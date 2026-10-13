import {describe,it,expect,vi} from 'vitest';
import {d1ResourcesContract} from '../../../shared/tests/d1Resources.contract';
import {authorizeSql,classifySql,boundQueryResult} from '../services/d1SqlPolicy';
import {D1Resources} from '../services/d1Resources';
import {BoundReadCache} from '../services/resourceCache';
import {ZoneDirectory} from '../services/zoneDirectory';
d1ResourcesContract('Worker',{authorizeSql,classifySql,boundQueryResult,D1Resources,BoundReadCache,ZoneDirectory},{describe,it,expect,vi});
