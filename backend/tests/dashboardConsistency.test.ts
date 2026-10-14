import {describe,it,expect} from 'vitest';
import * as collector from '../src/services/dashboardCollector';
import {dashboardConsistencyContract} from '../../shared/tests/dashboardConsistency.contract';
dashboardConsistencyContract('SQLite snapshot consistency',collector,{describe,it,expect});
