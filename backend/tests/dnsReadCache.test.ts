import { describe, it, expect, vi } from 'vitest';
import { dnsPerformanceContract } from '../../shared/tests/dnsPerformance.contract';
import { ZoneDirectory, recordPageQuery } from '../src/services/zoneDirectory';
import { ReadScheduler } from '../src/services/readScheduler';
dnsPerformanceContract('Docker', { ZoneDirectory, ReadScheduler, recordPageQuery }, { describe, it, expect, vi });
