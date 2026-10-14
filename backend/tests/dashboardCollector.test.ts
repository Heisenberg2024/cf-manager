import {describe,it,expect} from 'vitest';
import * as collector from '../src/services/dashboardCollector';
import {dashboardCollectorContract} from '../../shared/tests/dashboardCollector.contract';
dashboardCollectorContract('Docker collection',collector,{describe,it,expect});
