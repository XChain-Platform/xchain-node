# Two-hub regtest failover venue

This Compose venue gives the HF-15b drill two federated hubs with independent databases, three seed-driven indexers, and a BTC control indexer pinned to hub B. The BTC, LTC, and DOGE indexers all use `http://hub-a:10000,http://hub-b:10000` as `HUB_SEED_URLS`. `btc-indexer-control` has no seed list and uses `HUB_API_URL=http://hub-b:10000`.

Both hubs use the same `HUB_FEED_API_KEY`, `HUB_API_KEY`, and `HUB_REORG_API_KEY`. Their API and P2P endpoints, signing identities, peer seeds, and databases remain distinct. The one-shot `hub-federation-init` service registers both deterministic fixture signing identities in both hubs before any indexer starts. Fixture defaults are supplied for every interpolation so `docker compose config` works without a credential file. A CI caller can override the keys, database password, RPC credentials, seed list, and host ports through its environment.

Start the venue from the `xchain-node` repository:

```sh
docker compose -p hub-failover -f .github/hub-failover/compose.yml up -d --wait
```

HF-15b drives these service names:

| Role | Compose service | Default host port |
| --- | --- | ---: |
| Hub A API | `hub-a` | 64230 |
| Hub A P2P/feed | `hub-a` | 64231 |
| Hub B API | `hub-b` | 64232 |
| Hub B P2P/feed | `hub-b` | 64233 |
| Seed-driven BTC indexer | `btc-indexer` | 64205 |
| Hub-B-pinned BTC control | `btc-indexer-control` | 64207 |
| Seed-driven LTC indexer | `ltc-indexer` | 64214 |
| Seed-driven DOGE indexer | `doge-indexer` | 64224 |
| BTC, LTC, DOGE miners | `btc-miner`, `ltc-miner`, `doge-miner` | 64206, 64215, 64225 |

The drill records each seed-driven indexer's followed hub, stops that service with `docker compose stop hub-a` or `docker compose stop hub-b`, verifies movement and continued block progress, and restarts it with `docker compose start <service>`. It compares the moved `btc-indexer` with `btc-indexer-control` only while hub B remains available. Hub data is separate in `XChain_Hub_A` and `XChain_Hub_B`, so stopping and restarting a hub exercises peer catch-up rather than a shared database.

Stop the venue while preserving data with:

```sh
docker compose -p hub-failover -f .github/hub-failover/compose.yml down
```
