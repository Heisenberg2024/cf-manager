import {describe,it,expect} from 'vitest';
import * as collector from '../services/dashboardCollector';
import {dashboardConsistencyContract} from '../../../shared/tests/dashboardConsistency.contract';
dashboardConsistencyContract('D1 snapshot consistency',collector,{describe,it,expect});
