import type { SolSigner } from './signer.ts';
export interface PrivyConfig {
    appId: string;
    appSecret: string;
    /** The authorization private key from the dashboard ("wallet-auth:" + base64 PKCS#8), and the id of its key quorum: the signer the user adds to their wallet. */
    authKey: string;
    signerId: string;
    /** The policy the user attaches when adding the signer. A wallet whose signer carries another policy (or none) is refused. */
    policyId: string;
    apiUrl?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    /** Which wallets this client works with: 'solana' (default, method signTransaction) or 'ethereum' (EVM chains such as Base, method eth_signTransaction). */
    chainType?: 'solana' | 'ethereum';
}
/** RFC 8785 JSON canonicalization for the values Privy requests carry (objects, arrays, strings, integers, booleans, null). Keys sort by UTF-16 code units, as JS sort does. */
export declare function canonical(v: unknown): string;
/** The privy-authorization-signature header: ECDSA P-256 / SHA-256 (DER, base64) over the canonical JSON of the request. */
export declare function authorizationSignature(authKey: string, appId: string, method: 'POST', url: string, body: unknown): string;
export declare class PrivyError extends Error {
    status: number;
    constructor(msg: string, status: number);
}
export declare class PrivyApi {
    private c;
    private base;
    constructor(c: PrivyConfig);
    private req;
    get chainType(): "ethereum" | "solana";
    /** The method this client signs with (what the policy must ALLOW). */
    get signMethod(): "eth_signTransaction" | "signTransaction";
    /** The Privy wallet with this address (Solana, or 0x for ethereum: compared without case), or undefined when this app has none. */
    walletByAddress(address: string): Promise<{
        id: string;
        address: string;
        additional_signers?: {
            signer_id: string;
            override_policy_ids?: string[];
        }[];
    } | undefined>;
    /** Whether the user has added this app's signer, with this app's policy, to the wallet at `address`. */
    delegation(address: string): Promise<{
        ok: true;
        walletId: string;
    } | {
        ok: false;
        why: string;
    }>;
    /** Privy signs a serialized transaction (base64, signatures zeroed) and returns it signed. */
    signTransaction(walletId: string, txBase64: string): Promise<string>;
    /** EVM: Privy signs an unsigned type-2 transaction (fields as in @privy-io/api-types UnsignedStandardEthereumTransaction) and returns the signed RLP hex. */
    signEthTransaction(walletId: string, transaction: Record<string, string | number>): Promise<string>;
}
/** A SolSigner backed by Privy. `wallets` maps each address it may sign for to its Privy wallet id (checked with PrivyApi.delegation first). */
export declare class PrivySolSigner implements SolSigner {
    private api;
    private wallets;
    constructor(api: PrivyApi, wallets: Map<string, string>);
    sign(wallet: string, message: Uint8Array): Promise<Uint8Array>;
}
