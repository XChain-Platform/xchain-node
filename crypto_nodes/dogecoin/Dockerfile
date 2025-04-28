FROM ubuntu:20.04

ARG CONF_FILE=dogecoin.conf

COPY ./dogecoin /dogecoin
WORKDIR /dogecoin
RUN install -m 0755 -o root -g root -t /usr/local/bin /dogecoin/bin/*

RUN mkdir /root/.dogecoin/ 
COPY ./$CONF_FILE /root/.dogecoin/dogecoin.conf

CMD ["dogecoind"]