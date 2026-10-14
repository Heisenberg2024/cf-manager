import { describe, it, expect, vi } from 'vitest';
import { tunnelsRulesContract } from '../../../shared/tests/tunnelsRules.contract';
import { TunnelResources } from '../services/tunnelResources';
import { RulesResources } from '../services/rulesResources';
import { ZoneDirectory } from '../services/zoneDirectory';
import * as config from '../services/tunnelConfig';
import * as discovery from '../services/accountDiscovery';
tunnelsRulesContract('Worker', { TunnelResources, RulesResources, ZoneDirectory, config, discovery }, { describe, it, expect, vi });
