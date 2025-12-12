#!/usr/bin/env bash
#
# xchain-node installer script
#
# Install via :
#  sudo ln -s ~/xchain-node/xchain-node.sh /usr/local/bin/xchain-node
#
#######################################################################
cd ~/xchain-node/
/usr/bin/env node src/index.js "$@"