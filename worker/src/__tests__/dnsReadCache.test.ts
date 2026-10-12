import { describe, it, expect, vi } from 'vitest';
import { dnsPerformanceContract } from '../../../shared/tests/dnsPerformance.contract';
import { ZoneDirectory, recordPageQuery } from '../services/zoneDirectory';
import { ReadScheduler } from '../services/readScheduler';
dnsPerformanceContract('Worker', { ZoneDirectory, ReadScheduler, recordPageQuery }, { describe, it, expect, vi });
