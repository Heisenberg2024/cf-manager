import {describe,it,expect} from 'vitest';
import * as collector from '../services/dashboardCollector';
import {dashboardCollectorContract} from '../../../shared/tests/dashboardCollector.contract';
dashboardCollectorContract('Worker collection',collector,{describe,it,expect});
