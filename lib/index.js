import {Pool} from './pool';

export function createPool(poolOption, authorizeFn) {
    return new Pool(poolOption, authorizeFn);
}
