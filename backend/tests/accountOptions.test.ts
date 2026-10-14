import {describe,it,expect} from 'vitest';
import * as impl from '../src/services/accountOptions';
import {accountOptionsContract} from '../../shared/tests/accountOptions.contract';
accountOptionsContract('Docker account metadata',impl,{describe,it,expect});
