/*********************************************************************
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
 **********************************************************************
 * XChain Node - Constants & Configuration
 ********************************************************************/

const {
    NODE_MODULE_NAME,
    DB_MODULE_NAME,
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME,
    HUB_PORT,
    XChainService
} = require('./module_names.js')

// The fallback branch for an install with no named ref or resolved release,
// plus the branch selected for a bundled library that inherits no branch.
//
// This single name permits independent development and shipped defaults
// without scattering branch literals through clone paths: development may
// target `develop` while the platform's shipped default remains the release
// branch.
const DEFAULT_MODULE_BRANCH = "master"

// --- Library bundles ---
// Maps a service to the library modules that must be staged into its build
// context before docker build. Used by ModuleService.buildAndUp to clone +
// copy each library into the service's modules/ subdir; the service's
// Dockerfile then COPYs them in and npm resolves the file: link.
const LIBRARY_BUNDLES = {
    "xchain-indexer":  ["xchain-vm"],
    // xchain-explorer's flag-gated contract-simulation endpoint
    // (EXPLORER_VM_QUERY_ENABLED) lazy-requires xchain-vm as an
    // optionalDependency; staging it makes the feature available in built
    // images. Builds still succeed without it (endpoint 503s).
    "xchain-explorer": ["xchain-vm"],
    // xchain-e2e-test's multiValidatorHubHelper boots in-process XChainHub
    // instances against the regtest stack (multiHubAttestation,
    // llmAttestation). xchain-hub needs to ride into the build context so
    // those tests can `require` its source from inside the dockerized image.
    // xchain-sdk rides along the same way for the test:sdk suites
    // (test/sdk/sdkHelper.js loadSDK resolves the file: dep first).
    // xchain-contracts carries the contract-template source the template
    // suites load via XCHAIN_CONTRACTS_DIR (see ConfigService); without it
    // those suites skip rather than abort the run.
    // xchain-indexer is staged so the e2e suites that share the indexer's
    // consensus-critical primitives can `require('../../../xchain-indexer/src/...')`
    // from inside the dockerized image (those relative paths resolve to the
    // monorepo root locally, but to the image root /xchain-indexer here, where
    // the Dockerfile COPYs it). Without it attestationHelper (and the
    // integration/parity/regression suites) die with MODULE_NOT_FOUND at load.
    // xchain-sync rides along for ONE suite that cannot be replaced by a unit
    // golden: consensusHashConformance recomputes every indexed block's hashes with
    // sync's BlockHasher and compares them to the indexer's committed values, which
    // is the only place the two implementations meet over real stack data. Absent,
    // it does not fail - it SKIPS, so the drift-lock reported green while never
    // running (measured on the first hosted e2e run to reach the suites).
    "xchain-e2e-test": ["xchain-hub", "xchain-sdk", "xchain-contracts", "xchain-indexer", "xchain-sync"]
}

// Single source of truth for the per-service Docker run-args and the
// hub/explorer config descriptor. ModuleService.buildAndUp() and
// HubService.updateHubOrExplorer() consume this table: adding or renaming a
// service requires exactly one entry, and an omitted service surfaces as a
// missing key rather than a silently omitted install branch. The table is
// pure data; the two dispatch sites interpret it
// (ModuleService owns the docker-arg builder, HubService owns the config
// builder) so constants.js stays free of service-layer requires.
//
// docker facet (consumed by ModuleService.buildModuleDockerArgs):
//   singleton - true clears coin/network before naming/network resolution
//               (shared containers: hub, explorer, sync)
//   ports     - [{ host, container, always }]; pushed as `-p host:container`.
//               `always:true` pushes unconditionally (hub/explorer, whose
//               ports are structurally present); otherwise the pair is pushed
//               only when both env keys exist (preserves the old
//               `if (X in env && Y in env)` guards).
//   volumes   - each entry is one of:
//                 { hostKey, container }        static env-keyed bind mount
//                 { hostFn: 'utxoTrackerVolume', container }  dynamic volume name
//                 { type: 'hubCapabilityConfig' }  validator caps mount (ro)
//                 { type: 'hubSignerDir' }         operator signer mount (ro)
//   ulimits   - raw `--ulimit` values (e.g. 'nofile=2048:2048')
//
// hubConfig facet (consumed by HubService.buildHubModuleConfig):
//   { type: 'database' }  external-vs-dockerized MariaDB descriptor
//   { fields: { outKey: envKey, ... } }  descriptor read from the coin/network
//                                        default config. Absent = the module
//                                        contributes no hub config (hub,
//                                        explorer, sync, e2e-test).
const SERVICE_REGISTRY = {
    [NODE_MODULE_NAME]: {
        hubConfig: {
            fields: {
                host:        'NODE_URL',
                port:        'NODE_PORT',
                server_port: 'NODE_EXPOSED_PORT',
                user:        'NODE_USER',
                pass:        'NODE_PASSWORD'
            }
        }
    },
    [DB_MODULE_NAME]: {
        hubConfig: { type: 'database' }
    },
    [XChainService.XCHAIN_ENCODER]: {
        docker: {
            ports: [{ host: 'ENCODER_PORT', container: 'ENCODER_API_PORT' }]
        },
        hubConfig: {
            fields: { host: 'ENCODER_URL', port: 'ENCODER_API_PORT', server_port: 'ENCODER_PORT' }
        }
    },
    [XChainService.XCHAIN_DECODER]: {
        docker: {
            ports:   [{ host: 'DECODER_PORT', container: 'DECODER_API_PORT' }],
            volumes: [{ hostKey: 'DECODER_BOOTSTRAP_VOLUME', container: '/bootstrap/xchain-decoder' }]
        },
        hubConfig: {
            fields: {
                host:        'DECODER_URL',
                port:        'DECODER_API_PORT',
                server_port: 'DECODER_PORT',
                db_host:     'DECODER_DB_HOST',
                db_port:     'DECODER_DB_PORT',
                name:        'DECODER_DB_NAME',
                user:        'DECODER_DB_USER',
                pass:        'DECODER_DB_PASS'
            }
        }
    },
    [XChainService.XCHAIN_UTXO_TRACKER]: {
        docker: {
            ports:   [{ host: 'UTXO_TRACKER_PORT', container: 'UTXO_TRACKER_API_PORT' }],
            volumes: [
                { hostFn: 'utxoTrackerVolume', container: '/data/xchain-utxo-tracker' },
                { hostKey: 'UTXO_TRACKER_BOOTSTRAP_VOLUME', container: '/bootstrap/xchain-utxo-tracker' }
            ],
            ulimits: ['nofile=2048:2048']
        },
        hubConfig: {
            fields: { host: 'UTXO_TRACKER_URL', port: 'UTXO_TRACKER_API_PORT', server_port: 'UTXO_TRACKER_PORT' }
        }
    },
    [XChainService.XCHAIN_INDEXER]: {
        docker: {
            ports: [{ host: 'INDEXER_PORT', container: 'INDEXER_API_PORT' }]
        },
        hubConfig: {
            fields: {
                host:        'INDEXER_URL',
                port:        'INDEXER_API_PORT',
                server_port: 'INDEXER_PORT',
                db_host:     'INDEXER_DB_HOST',
                db_port:     'INDEXER_DB_PORT',
                name:        'INDEXER_DB_NAME',
                user:        'INDEXER_DB_USER',
                pass:        'INDEXER_DB_PASS'
            }
        }
    },
    [XChainService.XCHAIN_REGTEST_MINER]: {
        docker: {
            ports: [{ host: 'REGTEST_MINER_PORT', container: 'REGTEST_MINER_API_PORT' }]
        },
        hubConfig: {
            fields: { host: 'REGTEST_MINER_URL', port: 'REGTEST_MINER_API_PORT', server_port: 'REGTEST_MINER_PORT' }
        }
    },
    [HUB_MODULE_NAME]: {
        docker: {
            singleton: true,
            ports:   [
                { host: 'HUB_PORT', container: 'HUB_PORT', always: true },
                { host: 'P2P_PORT', container: 'P2P_PORT' }
            ],
            volumes: [{ type: 'hubCapabilityConfig' }, { type: 'hubSignerDir' }]
        }
    },
    [EXPLORER_MODULE_NAME]: {
        docker: {
            singleton: true,
            ports: [
                { host: 'EXPLORER_PORT_HTTP',  container: 'EXPLORER_API_PORT_HTTP',  always: true },
                { host: 'EXPLORER_PORT_HTTPS', container: 'EXPLORER_API_PORT_HTTPS', always: true }
            ]
        }
    },
    [SYNC_MODULE_NAME]: {
        docker: {
            singleton: true,
            ports: [{ host: 'SYNC_PORT', container: 'SYNC_API_PORT' }]
        }
    }
}

module.exports = {
    DEFAULT_MODULE_BRANCH,
    LIBRARY_BUNDLES,
    SERVICE_REGISTRY
}
