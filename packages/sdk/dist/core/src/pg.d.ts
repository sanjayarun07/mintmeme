export interface PgResult {
    rows: Record<string, string | null>[];
    command: string;
    rowCount: number;
}
export declare class PgError extends Error {
    code?: string | undefined;
    detail?: string | undefined;
    constructor(message: string, code?: string | undefined, detail?: string | undefined);
}
export declare function parsePgUrl(url: string): {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: string;
};
export declare class PgClient {
    private url;
    private o;
    private sock?;
    private buf;
    private chain;
    private waiter?;
    private ready?;
    constructor(url: string, o?: {
        timeoutMs?: number;
    });
    /** Run one statement with $1.. parameters (sent as text; null stays NULL). Queries on one client run in order. */
    query(sql: string, params?: unknown[]): Promise<PgResult>;
    close(): Promise<void>;
    private exec;
    private open;
    /** Feed server messages to `f` until it returns true. */
    private until;
    private drain;
}
