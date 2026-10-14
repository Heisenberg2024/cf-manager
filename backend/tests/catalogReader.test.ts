import {describe,it,expect} from 'vitest';
import * as impl from '../src/services/catalogReader';
import {catalogReaderContract} from '../../shared/tests/catalogReader.contract';
catalogReaderContract('Docker catalog',impl,{describe,it,expect});
