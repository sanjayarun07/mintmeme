import type { Intent, Quote } from './types.ts';
import type { ChainPort } from './port.ts';
export interface AggregatorBenchmark {
    name: string;
    quoteOut(i: Intent): bigint | undefined;
}
export interface RouteResult {
    best: Quote;
    all: Quote[];
    benchmark?: {
        source: 'aggregator';
        name: string;
        out: bigint;
        directVsBenchmarkBps: number;
    };
}
/** Direct-adapter router. Aggregator is only a labeled price benchmark here, never the execution path. */
export declare class Router {
    private chain;
    private bench?;
    constructor(chain: Pick<ChainPort, 'venues' | 'state' | 'block'>, bench?: AggregatorBenchmark | undefined);
    /** Follows graduation successors so orders/positions survive migration; successor must be in same authorized family. */
    private resolve;
    route(i: Intent, feeBps?: number): RouteResult;
}
