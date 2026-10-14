import { describe, it, expect, vi } from 'vitest';
import { tunnelsRulesContract } from '../../shared/tests/tunnelsRules.contract';
import { TunnelResources } from '../src/services/tunnelResources';
import { RulesResources } from '../src/services/rulesResources';
import { ZoneDirectory } from '../src/services/zoneDirectory';
import * as config from '../src/services/tunnelConfig';
import * as discovery from '../src/services/accountDiscovery';
tunnelsRulesContract('Docker', { TunnelResources, RulesResources, ZoneDirectory, config, discovery }, { describe, it, expect, vi });
