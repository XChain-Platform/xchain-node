FROM ubuntu:20.04

ARG CONF_FILE=bitcoin.conf

COPY ./bitcoin /bitcoin
WORKDIR /bitcoin
RUN install -m 0755 -o root -g root -t /usr/local/bin /bitcoin/bin/*

RUN mkdir /etc/bitcoin/
COPY ./$CONF_FILE /etc/bitcoin/bitcoin.conf

CMD ["bitcoind","-conf=/etc/bitcoin/bitcoin.conf", "-datadir=/root/.bitcoin/"]