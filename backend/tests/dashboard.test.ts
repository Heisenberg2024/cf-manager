import { describe,it,expect } from 'vitest';
import * as audit from '../src/services/auditQueries';
import * as data from '../src/services/dashboardData';
import { dashboardContract } from '../../shared/tests/dashboard.contract';
dashboardContract('Docker dashboard/audit SQL',audit,data,{describe,it,expect});
