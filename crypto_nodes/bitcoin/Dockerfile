FROM ubuntu:18.04

ARG CONF_FILE=bitcoin.conf

COPY ./bitcoin /bitcoin
WORKDIR /bitcoin
RUN install -m 0755 -o root -g root -t /usr/local/bin /bitcoin/bin/*

RUN mkdir /root/.bitcoin/ 
COPY ./$CONF_FILE /root/.bitcoin/bitcoin.conf

CMD ["bitcoind"]