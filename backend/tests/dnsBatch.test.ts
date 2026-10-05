import { describe, it, expect, vi } from 'vitest';
import { dnsBatchContract } from '../../shared/tests/dnsBatch.contract';
import * as implementation from '../src/services/dnsBatch';
dnsBatchContract('Express shared implementation', implementation, { describe, it, expect, vi });
