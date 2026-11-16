# Indexer (Ponder)

A separate service that reads Uniswap V2 / PancakeSwap V2 swap events from the chain and serves them to the terminal over the HTTP contract in `../docs/INDEXER_CONTRACT.md`. It has its own `package.json` so the terminal itself stays dependency-free.

```bash
cd indexer && npm install
```

Everything comes from environment variables; no address, chain id or RPC URL is built in (see the header of `ponder.config.ts`). Example for Ethereum:

```bash
INDEX_CHAINS=ethereum INDEX_RPC_ETHEREUM=<your RPC> INDEX_CHAIN_ID_ETHEREUM=<id> \
INDEX_POOLS_ETHEREUM=<pair,pair> INDEX_START_BLOCK_ETHEREUM=<recent block> \
INDEX_STABLES_ETHEREUM=<usdc,usdt> INDEX_WRAPPED_ETHEREUM=<weth> INDEX_REF_POOL_ETHEREUM=<weth/usdc pair> \
DATABASE_SCHEMA=meme npx ponder start --port 42069
```

Then run the terminal with `INDEX_URL=http://127.0.0.1:42069`.

Verified: `npm run verify:indexer` (local anvil fork, Ethereum USDC/WETH pair, 10 checks). Not yet verified: BNB, pools quoted in WETH, Postgres in production (Ponder uses embedded PGlite when `DATABASE_URL` is unset), mainnet backfill speed.

Indexed pools are a fixed list (`INDEX_POOLS_*`); discovering new pairs through the factory is a later step.
