import {describe,it,expect,vi} from 'vitest';
import {zoneSettingsContract} from '../../../shared/tests/zoneSettings.contract';
import {readZoneSettings,writeZoneSettings,ZoneSettingsRuntime} from '../services/zoneSettings';
import {BoundReadCache} from '../services/resourceCache';
import {ZoneDirectory} from '../services/zoneDirectory';
zoneSettingsContract('Worker',{readZoneSettings,writeZoneSettings,ZoneSettingsRuntime,BoundReadCache,ZoneDirectory},{describe,it,expect,vi});
