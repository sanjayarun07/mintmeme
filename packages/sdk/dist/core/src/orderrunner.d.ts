import { Reservations } from './reservations.ts';
import { OrderManager } from './orders.ts';
import type { Order, Snapshot } from './orders.ts';
import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { Intent } from './types.ts';
import type { Persist } from './durable.ts';
/**
 * Glue between price-triggered orders and a (possibly networked) chain: refreshes pool state, builds each order's Snapshot from real venue
 * reserves, hands fired intents to the Engine, and reports the engine outcome back to the OrderManager (bounded retries, reservation release).
 * Orders and reservations are in memory: after a restart re-place them. In-flight executions ARE durable (engine store) and are re-adopted by adopt();
 * re-placing an order reuses its idempotency keys, so it cannot execute twice.
 */
export declare class OrderRunner {
    private d;
    orders: OrderManager;
    reservations: Reservations;
    inflight: Map<string, string>;
    lastVenueRefreshMs: number;
    skipped: Map<string, string>;
    outbox: Intent[];
    vetoed: string[];
    private bal;
    private backend?;
    constructor(d: {
        engine: Engine;
        chain: ChainPort;
        clockMs: () => number;
        gate?: ConstructorParameters<typeof OrderManager>[4];
        persistPath?: Persist;
        /** Optional veto at hand-over time (e.g. 'pause new automated entries'). A refused intent is NOT sent; the order is told it failed (bounded retries, reservation released). */
        entryGate?: (i: Intent) => boolean;
    });
    /** Atomically write all order state. No-op without persistPath. A write failure propagates: callers stop BEFORE acting (fail closed). */
    checkpoint(): void;
    cancel(id: string): void;
    retrigger(id: string, priceE18: bigint): Order;
    private sync;
    /** Reserve against the CURRENT on-chain balance, then place. */
    place(o: Order): Promise<Order>;
    refresh(): Promise<void>;
    /** Snapshot from the freshest pool state. Undefined (with a recorded reason) when the order cannot be honestly evaluated. */
    snapshot(o: Order): Snapshot | undefined;
    /** One pass: refresh -> evaluate -> execute fired -> settle what is in flight. */
    tick(): Promise<{
        fired: string[];
        submitted: string[];
    }>;
    /** Hand outbox intents to the engine (idempotent per key), then move them to in-flight. Safe to repeat after a crash. */
    private flushOutbox;
    /** After a crash/restart: finish handing over the outbox, re-attach unfinished executions, settle. Call once after constructing with the same persistPath and engine store. */
    resume(): Promise<void>;
    /** Re-attach to unfinished order executions after a restart. */
    adopt(): void;
    /** Advance in-flight executions; report outcomes to the OrderManager exactly once. */
    settle(): Promise<void>;
}
