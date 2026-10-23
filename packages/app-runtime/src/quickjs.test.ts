import { runContractSuite } from './contract-suite.js';
import { createRuntime } from './runtime.js';

runContractSuite('quickjs', () => createRuntime({ engine: 'quickjs' }));
