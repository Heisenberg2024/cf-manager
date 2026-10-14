import {describe,it,expect} from 'vitest';
import * as impl from '../services/catalogReader';
import {catalogReaderContract} from '../../../shared/tests/catalogReader.contract';
catalogReaderContract('Worker catalog',impl,{describe,it,expect});
