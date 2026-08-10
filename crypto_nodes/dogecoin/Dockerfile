FROM ubuntu:20.04

ARG CONF_FILE=dogecoin.conf

COPY ./dogecoin /dogecoin
WORKDIR /dogecoin
RUN install -m 0755 -o root -g root -t /usr/local/bin /dogecoin/bin/*

RUN mkdir /etc/dogecoin/
COPY ./$CONF_FILE /etc/dogecoin/dogecoin.conf

# RPC liveness probe; see crypto_nodes/bitcoin/Dockerfile for the full rationale.
# Without it docker inspect leaves State.Health empty and a wedged-but-alive daemon
# reads as a clean "running" forever. dogecoin-cli reads the same conf for its
# rpcuser/rpcpassword and rpcport. Probe-only: no autoheal entry exists for the
# node module, so a wedge surfaces for operator triage rather than a blind restart.
HEALTHCHECK --interval=60s --timeout=30s --start-period=1800s --retries=3 \
    CMD dogecoin-cli -conf=/etc/dogecoin/dogecoin.conf getblockchaininfo > /dev/null 2>&1 || exit 1

CMD ["dogecoind","-conf=/etc/dogecoin/dogecoin.conf"]