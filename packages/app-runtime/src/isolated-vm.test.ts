import { runContractSuite } from './contract-suite.js';
import { createRuntime } from './runtime.js';

runContractSuite('isolated-vm', () => createRuntime({ engine: 'isolated-vm' }));
