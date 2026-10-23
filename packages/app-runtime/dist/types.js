/**
 * `@olan-app/runtime` interface (Phase 3 contract §15.2). Both engines and the process client
 * implement {@link AppRuntime}; the Platform service only talks to this interface.
 */
/** Argument and result size cap (§8.1). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Console lines kept per invocation (§8.1); one truncation marker follows. */
export const MAX_LOG_LINES = 1000;
/** Bytes kept per console line. */
export const MAX_LOG_LINE_BYTES = 4 * 1024;
