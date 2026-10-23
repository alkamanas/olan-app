import type * as IvmModule from 'isolated-vm';
import { type EngineDriver } from '../core.js';
type Ivm = typeof IvmModule;
/** Loads the native module once; returns the reason when no prebuild/binary is usable here. */
export declare function loadIsolatedVm(): {
    ivm: Ivm;
} | {
    error: Error;
};
export interface IsolatedVmDriverOptions {
    onCatastrophicError: (message: string) => void;
}
export declare function isolatedVmDriver(ivm: Ivm, options: IsolatedVmDriverOptions): EngineDriver;
export {};
