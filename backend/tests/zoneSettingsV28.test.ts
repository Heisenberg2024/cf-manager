import {describe,it,expect,vi} from 'vitest';
import {zoneSettingsContract} from '../../shared/tests/zoneSettings.contract';
import {readZoneSettings,writeZoneSettings,ZoneSettingsRuntime} from '../src/services/zoneSettings';
import {BoundReadCache} from '../src/services/resourceCache';
import {ZoneDirectory} from '../src/services/zoneDirectory';
zoneSettingsContract('Docker',{readZoneSettings,writeZoneSettings,ZoneSettingsRuntime,BoundReadCache,ZoneDirectory},{describe,it,expect,vi});
