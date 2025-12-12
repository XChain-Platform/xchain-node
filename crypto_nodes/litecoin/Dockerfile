FROM ubuntu:20.04

ARG CONF_FILE=litecoin.conf

COPY ./litecoin /litecoin
WORKDIR /litecoin
RUN install -m 0755 -o root -g root -t /usr/local/bin /litecoin/bin/*

RUN mkdir /etc/litecoin/
COPY ./$CONF_FILE /etc/litecoin/litecoin.conf

CMD ["litecoind","-conf=/etc/litecoin/litecoin.conf"]