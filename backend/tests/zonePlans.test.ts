import { describe, it, expect } from 'vitest';
import { zonePlansContract } from '../../shared/tests/zonePlans.contract';
import * as implementation from '../src/services/zonePlans';
zonePlansContract('Express Zone plan allocation', implementation, { describe, it, expect });
