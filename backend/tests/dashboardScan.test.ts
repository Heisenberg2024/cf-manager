import {describe,it,expect} from 'vitest';
import * as scan from '../src/services/dashboardScan';
import {dashboardScanContract} from '../../shared/tests/dashboardScan.contract';
dashboardScanContract('Docker persistent scan',scan,{describe,it,expect});
