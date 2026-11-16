/** Atomic durable write: write a temp file, fsync it, rename over the target, fsync the directory. A crash leaves either the old file or the new one, never a torn one. */
export declare function writeAtomic(path: string, data: string): void;
export declare function readIfExists(path: string): string | undefined;
/** Where one blob of durable state lives. Writes are SYNCHRONOUS and durable-on-return: callers checkpoint before acting (write-ahead), so a write failure must throw. */
export interface Backend {
    read(): string | undefined;
    write(data: string): void;
    describe(): string;
}
export declare const fileBackend: (path: string) => Backend;
/** A path string (file) or any Backend (e.g. Redis). */
export type Persist = string | Backend;
export declare const toBackend: (p: Persist) => Backend;
