/*********************************************************************
 * XChain Kaspa Node - crypto_node module
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *
 * Why this is a module of its own: the platform's crypto_nodes/* and node_service/* are all
 * written for the bitcoind family (-conf= startup, <coin>-cli liveness, base58 addresses),
 * while Kaspa is a Rust full node (kaspad) with different flags, ports and liveness.
 * This module keeps that surface as pure functions, so it can be tested offline.
 *
 * Only VERIFIED facts are encoded (each one carries its source); anything unverified is left
 * blank and fails closed:
 *   - ports: mainnet/testnet come from the help text of kaspad/src/args.rs; simnet defaults
 *            are UNVERIFIED, so they must be passed explicitly - never guessed;
 *   - hashes: win64 was computed locally (sha256sum); linux-amd64 was blocked, so null - and
 ********************************************************************/
'use strict';

const REPO = 'kaspanet/rusty-kaspa';
const VERSION = 'v2.1.0';

const ASSETS = {
    'linux-amd64': {
        file: 'rusty-kaspa-v2.1.0-linux-amd64.zip',
        sha256: null,                    // TODO: this host cannot reach that CDN (SSL 35). See ASSET-HASHES.md
        note: 'the one the Docker image uses'
    },
    'win64': {
        file: 'rusty-kaspa-v2.1.0-win64.zip',
        sha256: 'fb25743a4b432d376c4ca49d8799769dbc6d5b070f0b502350ce32cfdb38ec0f',  // computed locally with sha256sum
        note: 'for local development and debugging'
    },
    'osx': {
        file: 'rusty-kaspa-v2.1.0-osx.zip',
        sha256: null,                    // TODO
        note: ''
    }
};

// Measured from the help text of kaspad/src/args.rs:
//   "gRPC connections (default port: 16110, testnet: 16210)"
//   "wRPC Borsh connections (default port: 17110, testnet: 17210)"
//   "wRPC JSON connections (default port: 18110, testnet: 18210)"
//   "listen for connections (default all interfaces port: 16111, testnet: 16211)"
const PORTS = {
    mainnet: { grpc: 16110, p2p: 16111, wrpcBorsh: 17110, wrpcJson: 18110 },
    testnet: { grpc: 16210, p2p: 16211, wrpcBorsh: 17210, wrpcJson: 18210 },
    simnet: null                          // UNVERIFIED: ports must be passed explicitly, never guessed
};

function assetFor(platform) {
    const a = ASSETS[platform];
    if (!a) throw new Error('unknown platform: ' + platform + ' (choose one of: ' + Object.keys(ASSETS).join(', ') + ')');
    return a;
}

function downloadUrl(platform) {
    return 'https://github.com/' + REPO + '/releases/download/' + VERSION + '/' + assetFor(platform).file;
}

// fail-closed: no trusted hash means no download (offline verification is the whole point)
function assertHashKnown(platform) {
    const a = assetFor(platform);
    if (!a.sha256) {
        throw new Error('refusing to download ' + platform + ': no registered sha256 (hashes are never invented). ' +
            'Run `sha256sum ' + a.file + '` on a host that can reach GitHub, then fill it in here');
    }
    return a.sha256;
}

function verifySha256(actualHex, expectedHex) {
    const a = String(actualHex || '').trim().toLowerCase();
    const e = String(expectedHex || '').trim().toLowerCase();
    if (a.length !== 64 || e.length !== 64) throw new Error('sha256 must be 64 hex characters');
    return a === e;
}

function portsFor(network, explicit) {
    if (explicit) return Object.assign({}, explicit);
    const p = PORTS[network];
    if (!p) throw new Error('default ports for network=' + network + ' are unverified; pass ports explicitly');
    return Object.assign({}, p);
}

// Only flags that were MEASURED (the CLI and help text of args.rs)
function buildRunArgs({ network, appdir, ports, archival = false, utxoindex = true, allowUnsyncedMining = false, extra = [] }) {
    if (!['mainnet', 'testnet', 'simnet', 'devnet'].includes(network)) throw new Error('unknown network: ' + network);
    if (!appdir) throw new Error('appdir is required');
    const p = portsFor(network, ports);
    const args = [];
    if (network === 'testnet') args.push('--testnet');       // default suffix 10 (args.rs: netsuffix 10)
    if (network === 'simnet') args.push('--simnet');
    if (network === 'devnet') args.push('--devnet');
    args.push('--appdir=' + appdir);
    if (utxoindex) args.push('--utxoindex');
    if (archival) args.push('--archival');                    // the decoder needs history (KIP-15 keeps ~30h)
    if (allowUnsyncedMining) args.push('--enable-unsynced-mining');
    args.push('--rpclisten=127.0.0.1:' + p.grpc);
    args.push('--rpclisten-borsh=127.0.0.1:' + p.wrpcBorsh);
    args.push('--rpclisten-json=127.0.0.1:' + p.wrpcJson);
    args.push('--listen=127.0.0.1:' + p.p2p);
    args.push('--yes');                                       // non-interactive (required in a container)
    args.push('--disable-upnp');                              // no UPnP in a container (measured: it errors)
    return args.concat(extra);
}

// Liveness, for the Docker HEALTHCHECK. kaspad has no <coin>-cli, so it uses
//   (a) the wRPC port is listening, and (b) the log directory saw a new file within N
function buildHealthProbe({ wrpcBorshPort, logDir, freshMinutes = 5 }) {
    if (!wrpcBorshPort) throw new Error('wrpcBorshPort is required');
    const parts = ['sh', '-c'];
    const cmd = 'nc -z 127.0.0.1 ' + wrpcBorshPort +
        (logDir ? ' && find ' + logDir + ' -type f -mmin -' + freshMinutes + ' | grep -q .' : '');
    parts.push(cmd);
    return parts;
}

// -- The three places where the missing <coin>-cli changes the shape (every other coin has it) --
// The platform's bootstrap_node_tip_guard takes the tip from `<coin>-cli -conf=... getblockcount`;
// kaspad has no such CLI, so this uses wRPC-JSON instead.
// Measured: ws://127.0.0.1:<wrpcJson>/json accepts JSON-RPC directly (see the 11.8 smoke test).
function tipGuardPlan({ wrpcJsonPort, network }) {
    if (!wrpcJsonPort) throw new Error('wrpcJsonPort is required');
    const p = portsFor(network, network === 'simnet' ? { wrpcJson: wrpcJsonPort } : undefined);
    const port = p.wrpcJson || wrpcJsonPort;
    return {
        url: 'ws://127.0.0.1:' + port + '/json',
        method: 'getBlockDagInfo',
        params: {},
        // Tip: sink (the currently selected tip) first, falling back to pruningPointHash for reachability
        pick: ["sink", "pruningPointHash"],
        note: 'replaces `<coin>-cli getblockcount`; kaspad has no CLI (measured)'
    };
}

function remoteVersionProbe({ wrpcJsonPort }) {
    if (!wrpcJsonPort) throw new Error('wrpcJsonPort is required');
    return {
        url: 'ws://127.0.0.1:' + wrpcJsonPort + '/json',
        method: 'getServerInfo',
        params: {},
        // version_service reads it to decide the remote node version
        pick: ['serverVersion'],
        note: 'replaces `<coin>-cli getnetworkinfo`; returns something like "2.1.0" (measured)'
    };
}

// The Docker HEALTHCHECK start-period.
// Not minutes: a measured TN-10 first sync downloads 1,476,465 headers plus hundreds of
// millions of UTXOs, and every RPC answers "consensus is currently in a transitional ibd
// state" for its whole duration, so a minute-scale start-period would call a healthy node
function healthStartPeriodSeconds({ network, archival = false, firstSync = true } = {}) {
    if (!firstSync) return 600;                 // a snapshot/data dir is already in place: starts fast
    if (network === 'simnet') return 120;       // no PoW and no peers
    // Mainnet/testnet first sync: hours; archival gets double that (it rebuilds history)
    return archival ? 6 * 3600 * 2 : 6 * 3600;
}

// -- A stable "is it still in IBD" test (corrected after measuring the wrong one) ---------────
// Measured: one simnet node read isSynced=true while mining and false once idle, so a bare
// !isSynced calls a HEALTHY node "still loading". Progress comes first, isSynced second:
//   - headerCount/blockCount grew between probes: genuinely catching up (true);
//   - unchanged across both probes: caught up (false);
//   - too few samples or jittery numbers: conservatively true (let the caller retry).
function judgeInitialBlockDownload({ first, second, isSynced } = {}) {
    if (!first || !second) return { initialblockdownload: true, reason: 'not enough samples; waiting conservatively' };
    const h1 = Number(first.headerCount || 0), h2 = Number(second.headerCount || 0);
    const b1 = Number(first.blockCount || 0), b2 = Number(second.blockCount || 0);
    if (h2 > h1 || b2 > b1) return { initialblockdownload: true, reason: 'headerCount/blockCount still growing' };
    if (h2 === h1 && b2 === b1) return { initialblockdownload: false, reason: 'no growth across two probes (caught up)' };
    if (isSynced === true) return { initialblockdownload: false, reason: 'isSynced=true' };
    return { initialblockdownload: true, reason: 'values unstable; waiting conservatively' };
}

module.exports = {
    REPO, VERSION, ASSETS, PORTS,
    assetFor, downloadUrl, assertHashKnown, verifySha256,
    portsFor, buildRunArgs, buildHealthProbe,
    tipGuardPlan, remoteVersionProbe, healthStartPeriodSeconds,
    judgeInitialBlockDownload
};
