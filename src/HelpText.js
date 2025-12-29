/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Node - Help text 
 * 
 * This file provides the help text for the xchain-node installer
 *
 ********************************************************************/

module.exports = {

// Default
default: `
Examples:
    xchain-node -i
    xchain-node --interactive
    xchain-node -h install
    xchain-node -h restart
    xchain-node -h update
    xchain-node -h tail
`,


// Install
install: `
Params:
    <branch>    (master, develop)
    <service>   (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)
    [chain]     (bitcoin, litecoin, dogecoin, all) 
    [network]   (mainnet, testnet, regtest, all)

Notes:
    If <service>, [chain], or [network] are not given, all is assumed
`,


// Uninstall
uninstall: `
Params:
    <service>   (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)
    [chain]     (bitcoin, litecoin, dogecoin, all) 
    [network]   (mainnet, testnet, regtest, all)

Notes:
    If <service>, [chain], or [network] are not given, all is assumed
`,


// Update
update: `
Params:
    <service>   (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)
    [chain]     (bitcoin, litecoin, dogecoin, all) 
    [network]   (mainnet, testnet, regtest, all)

Notes:
    If <service>, [chain], or [network] are not given, all is assumed
`,


// Start / Stop / Restart Services
services: `
Params:
    <service>   (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)
    [chain]     (bitcoin, litecoin, dogecoin, all) 
    [network]   (mainnet, testnet, regtest, all)

Notes:
    If <service>, [chain], or [network] are not given, all is assumed
`,


// Log Services
logs: `
Params:
    <service>   (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)
    [chain]     (bitcoin, litecoin, dogecoin) 
    [network]   (mainnet, testnet, regtest)

Notes:
    [chain] and [network] are required unless <service> is xchain-explorer
`,


// Rollback
rollback: `
Params:
    <block_index>  The index of the last known good block
    <service>      (node, xchain-decoder, xchain-utxo-tracker, xchain-indexer, all)
    <chain>        (bitcoin, litecoin, dogecoin) 
    <network>      (mainnet, testnet, regtest)
`,


// Create / Restore Bootstraps
bootstrap: `
Params:
    <action>       (create, restore)
    <service>      (xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-hub)
    <chain>        (bitcoin, litecoin, dogecoin) 
    <network>      (mainnet, testnet, regtest)

Notes:
    Bootstrap files are written to and restored from ~/xchain-node/bootstraps/<chain>/<network>/<service>/bootstrap-<block_index>.tgz
    bootstrap create generates a bootstrap.tgz file in the above directory
    bootstrap restore downloads a bootstrap.tgz file to the above directory and restores it
`,


// Execute command on service container
exec: `
Params:
    <service>      (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)
    <chain>        (bitcoin, litecoin, dogecoin) 
    <network>      (mainnet, testnet, regtest)
    <command>      The shell command to execute
`,


// Shell into service container
shell: `
Params:
    <service>      (node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)
    <chain>        (bitcoin, litecoin, dogecoin) 
    <network>      (mainnet, testnet, regtest)
`,


};
