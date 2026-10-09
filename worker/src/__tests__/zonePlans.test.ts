import { describe, it, expect } from 'vitest';
import { zonePlansContract } from '../../../shared/tests/zonePlans.contract';
import * as implementation from '../services/zonePlans';
zonePlansContract('Hono Zone plan allocation', implementation, { describe, it, expect });
