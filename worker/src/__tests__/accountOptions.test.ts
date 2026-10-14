import {describe,it,expect} from 'vitest';
import * as impl from '../services/accountOptions';
import {accountOptionsContract} from '../../../shared/tests/accountOptions.contract';
accountOptionsContract('Worker account metadata',impl,{describe,it,expect});
