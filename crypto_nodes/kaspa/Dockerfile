# Kaspa node image (crypto_nodes/kaspa of xchain-node)
#
# Differences from the bitcoind family (why bitcoin/ could not simply be reused):
#   · kaspad is a Rust full node with no <coin>-cli, so liveness uses the wRPC port plus log freshness;
#   · it is not driven by a single -conf= file, so configuration is TOML (--configfile) plus CLI overrides;
#   · wRPC (Borsh/JSON) is the indexer's and SDK's interface, so it must listen explicitly.
#
# The directory convention matches the other coins: crypto_nodes/kaspa/ holds binaries that are
# already downloaded and verified (node_service checks sha256 from github_hashes.json; this only installs).

FROM ubuntu:22.04

ARG CONF_FILE=kaspa-mainnet.conf

# netcat for the HEALTHCHECK port probe; ca-certificates for runtime TLS
RUN apt-get update \
 && apt-get install -y --no-install-recommends netcat-openbsd ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# binaries: the release archive is flat (kaspad / kaspa-wallet / rothschild / stratum-bridge)
COPY ./kaspa /kaspa
WORKDIR /kaspa
RUN install -m 0755 -o root -g root -t /usr/local/bin /kaspa/kaspad \
 && (ls /kaspa/kaspa-wallet >/dev/null 2>&1 && install -m 0755 -o root -g root -t /usr/local/bin /kaspa/kaspa-wallet || true)

COPY ./$CONF_FILE /etc/kaspa/kaspad.conf

# liveness = the wRPC port is listening AND the log was written to in the last five minutes.
# The second half catches wedges where the process lives but stops working; a port probe alone misses
# those (kaspad usually keeps its port). The probe only reports, as with the other coins: operators decide.
# start-period is hours on purpose: a first sync downloads ~1.4M headers and hundreds of
# millions of UTXOs, and kaspad answers every RPC with an IBD error for that whole window.
# A minutes-scale start-period would declare a healthy syncing node unhealthy. The value is
# pinned to crypto_nodes/kaspa/kaspa_node.js healthStartPeriodSeconds() by a unit test.
HEALTHCHECK --interval=60s --timeout=30s --start-period=43200s --retries=3 \
    CMD sh -c 'nc -z 127.0.0.1 ${KASPAD_WRPC_BORSH_PORT:-17110} && find /data/kaspa/logs -type f -mmin -5 | grep -q .' || exit 1

# --yes is for non-interactive use (required in a container); the rest comes from TOML
CMD ["kaspad","--configfile=/etc/kaspa/kaspad.conf","--yes"]
