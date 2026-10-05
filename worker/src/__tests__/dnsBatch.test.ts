import { describe, it, expect, vi } from 'vitest';
import { dnsBatchContract } from '../../../shared/tests/dnsBatch.contract';
import * as implementation from '../services/dnsBatch';
dnsBatchContract('Hono shared implementation', implementation, { describe, it, expect, vi });
