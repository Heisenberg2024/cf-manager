import {describe,it,expect} from 'vitest';
import * as scan from '../services/dashboardScan';
import {dashboardScanContract} from '../../../shared/tests/dashboardScan.contract';
dashboardScanContract('Worker persistent scan',scan,{describe,it,expect});
