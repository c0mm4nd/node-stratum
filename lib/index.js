import { Pool } from './pool';
const createPool = function (poolOptions, authorizeFn) {
    return new Pool(poolOptions, authorizeFn);
};
export { createPool };
