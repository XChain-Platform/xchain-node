FROM ubuntu:20.04

ARG CONF_FILE=bitcoin.conf

COPY ./bitcoin /bitcoin
WORKDIR /bitcoin
RUN install -m 0755 -o root -g root -t /usr/local/bin /bitcoin/bin/*

RUN mkdir /etc/bitcoin/
COPY ./$CONF_FILE /etc/bitcoin/bitcoin.conf

# RPC liveness probe. Without it docker inspect leaves State.Health empty for a
# coin node, so a wedged-but-alive daemon (RPC deadlock, stuck txindex, I/O-starved
# thread hang) reads as a clean "running" forever while its downstream consumers
# stall. bitcoin-cli reads the same conf, so it picks up the rpcuser/rpcpassword
# and rpcport the daemon is serving on. start-period is long because every RPC
# answers -28 during block-index/txindex warmup; widen it for a slow disk. Kept
# probe-only on purpose: no autoheal entry exists for the node module, mirroring
# the deliberate xchain-utxo-tracker exclusion, because a wedged daemon usually
# means corrupt state that a blind restart re-enters and an operator must triage.
HEALTHCHECK --interval=60s --timeout=30s --start-period=1800s --retries=3 \
    CMD bitcoin-cli -conf=/etc/bitcoin/bitcoin.conf -datadir=/root/.bitcoin/ getblockchaininfo > /dev/null 2>&1 || exit 1

CMD ["bitcoind","-conf=/etc/bitcoin/bitcoin.conf", "-datadir=/root/.bitcoin/"]