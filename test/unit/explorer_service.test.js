'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { configStub } = require('../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const EXPLORER_MODULE_NAME = 'xchain-explorer'

function makeExplorerServiceStubs(overrides = {}) {
    return {
        db: {
            getModuleContainer:    overrides.dbGetModuleContainer    || sinon.stub().resolves(null),
            deleteModuleContainer: overrides.dbRemoveModuleContainer || sinon.stub().resolves()
        },
        getLastStatus:    overrides.getLastStatus    || sinon.stub().returns(null),
        isStatusUpdated:  overrides.isStatusUpdated  || sinon.stub().returns(false),
        sleep:            overrides.sleep            || sinon.stub().resolves(),
        getDefaultConfig: overrides.getDefaultConfig || sinon.stub().resolves({
            EXPLORER_HOST: 'localhost',
            EXPLORER_PORT: 18080
        }),
        getDockerNetwork: overrides.getDockerNetwork || sinon.stub().returns('xchain-node-bitcoin-mainnet'),
        getInstalledCoinsAndNetworks: overrides.getInstalledCoinsAndNetworks || sinon.stub().resolves({}),
        statusChanged:    overrides.statusChanged    || sinon.stub().resolves(),
        getStatus:        overrides.getStatus        || sinon.stub().resolves({}),
        addContainerToNetwork: overrides.addContainerToNetwork || sinon.stub().resolves(),
        killContainer:    overrides.killContainer    || sinon.stub().resolves(),
        removeContainer:  overrides.removeContainer  || sinon.stub().resolves(),
        cloneGit:         overrides.cloneGit         || sinon.stub().resolves(true),
        buildAndUp:       overrides.buildAndUp       || sinon.stub().resolves('c'.repeat(64)),
        explorerPing:     overrides.explorerPing     || sinon.stub().resolves(false),
        explorerProbe:    overrides.explorerProbe    || null,
        // Default is the no-active-release answer the real service gives: the
        // caller's ref passes through unpinned.
        resolveComponentRef: overrides.resolveComponentRef
            || sinon.stub().callsFake((component, fallbackRef) => ({ ref: fallbackRef, commit: null, pinned: false }))
    }
}

function loadExplorerService(stubs) {
    // Build a mock ExplorerConnector class so we can control ping()
    const MockExplorerConnector = sinon.stub()
    MockExplorerConnector.prototype.ping = stubs.explorerPing
    // probe() is what the install path reads. Default it to the real class's own
    // relationship between the two (a healthy explorer answers; an unhealthy one
    // is assumed silent) so every pre-existing case keeps its meaning, and let a
    // test override it to express the third state: answering but degraded.
    MockExplorerConnector.prototype.probe = stubs.explorerProbe
        || (async function () {
            const healthy = await stubs.explorerPing()
            return { answering: healthy, healthy }
        })

    return proxyquire('../../src/services/explorer_service', {
        '../config': configStub({
            EXPLORER_MODULE_NAME: 'xchain-explorer'
        }),
        '../state': {
            db:              stubs.db,
            getLastStatus:   stubs.getLastStatus,
            isStatusUpdated: stubs.isStatusUpdated
        },
        '../utils/helpers': {
            sleep:         stubs.sleep,
            redactSecrets: (err) => String(err && err.message ? err.message : err)
        },
        './config_service': {
            getDefaultConfig: stubs.getDefaultConfig,
            getDockerNetwork: stubs.getDockerNetwork
        },
        './status_service': {
            statusChanged:                stubs.statusChanged,
            getStatus:                    stubs.getStatus,
            getInstalledCoinsAndNetworks: stubs.getInstalledCoinsAndNetworks
        },
        './docker_service': {
            addContainerToNetwork: stubs.addContainerToNetwork,
            killContainer:         stubs.killContainer,
            removeContainer:       stubs.removeContainer
        },
        './module_service': {
            cloneGit:   stubs.cloneGit,
            buildAndUp: stubs.buildAndUp
        },
        './release_manifest_service': {
            resolveComponentRef: stubs.resolveComponentRef
        },
        './explorer_connector.js': MockExplorerConnector
    })
}

describe('ExplorerService: updateExplorer()', function () {

    it('returns true immediately when explorer entry is absent from lastStatus', async function () {
        const stubs = makeExplorerServiceStubs({
            getLastStatus: sinon.stub().returns(null)
        })
        const es = loadExplorerService(stubs)
        const result = await es.updateExplorer()
        expect(result).to.be.true
        expect(stubs.addContainerToNetwork.called).to.be.false
    })

    it('returns true immediately when explorer container is exited', async function () {
        const lastStatus = {
            '': {
                '': {
                    'xchain-explorer': {
                        status: { State: { Status: 'exited' } }
                    }
                }
            }
        }
        const stubs = makeExplorerServiceStubs({
            getLastStatus: sinon.stub().returns(lastStatus)
        })
        const es = loadExplorerService(stubs)
        const result = await es.updateExplorer()
        expect(result).to.be.true
        expect(stubs.addContainerToNetwork.called).to.be.false
    })

    it('connects explorer container to all installed coin networks', async function () {
        const lastStatus = {
            '': {
                '': {
                    'xchain-explorer': {
                        status: { State: { Status: 'running' } }
                    }
                }
            }
        }
        const stubs = makeExplorerServiceStubs({
            getLastStatus: sinon.stub().returns(lastStatus),
            dbGetModuleContainer: sinon.stub().resolves('explorer-cid'),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({
                bitcoin:  ['mainnet'],
                dogecoin: ['testnet', 'mainnet']
            })
        })
        const es = loadExplorerService(stubs)
        const result = await es.updateExplorer()
        expect(result).to.be.true
        expect(stubs.addContainerToNetwork.callCount).to.equal(3)
    })
})

describe('ExplorerService: updateExplorer()', function () {

    it('retries a failed attach once and returns true when the retry succeeds', async function () {
        const lastStatus = {
            '': {
                '': {
                    'xchain-explorer': {
                        status: { State: { Status: 'running' } }
                    }
                }
            }
        }
        const addContainerToNetwork = sinon.stub()
        addContainerToNetwork.onCall(0).rejects(new Error('docker race'))
        addContainerToNetwork.onCall(1).resolves()
        const stubs = makeExplorerServiceStubs({
            getLastStatus: sinon.stub().returns(lastStatus),
            dbGetModuleContainer: sinon.stub().resolves('explorer-cid'),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({
                bitcoin: ['mainnet']
            }),
            addContainerToNetwork
        })
        const es = loadExplorerService(stubs)
        const result = await es.updateExplorer()
        expect(result).to.be.true
        expect(addContainerToNetwork.callCount).to.equal(2)
        expect(stubs.sleep.called).to.be.true
    })
})

describe('ExplorerService: updateExplorer()', function () {

    // Contract change: a persistently unreachable network used to be
    // logged and swallowed, so a topology change reported success while the
    // explorer sat disconnected. It now rejects, naming every network it failed.
    it('rejects naming the unreachable networks when the attach keeps failing', async function () {
        const lastStatus = {
            '': {
                '': {
                    'xchain-explorer': {
                        status: { State: { Status: 'running' } }
                    }
                }
            }
        }
        const stubs = makeExplorerServiceStubs({
            getLastStatus: sinon.stub().returns(lastStatus),
            dbGetModuleContainer: sinon.stub().resolves('explorer-cid'),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({
                bitcoin:  ['mainnet'],
                dogecoin: ['testnet']
            }),
            addContainerToNetwork: sinon.stub().rejects(new Error('network error'))
        })
        const es = loadExplorerService(stubs)

        let threw = null
        try {
            await es.updateExplorer()
        } catch (err) {
            threw = err
        }

        expect(threw).to.be.an('error')
        expect(threw.message).to.include('xchain-explorer -> bitcoin/mainnet')
        expect(threw.message).to.include('xchain-explorer -> dogecoin/testnet')
        expect(threw.cause).to.be.an('error')
        // Every network is attempted before the throw: 2 networks x (try + retry)
        expect(stubs.addContainerToNetwork.callCount).to.equal(4)
    })
})

describe('ExplorerService: updateExplorer()', function () {

    it('skips network connection when no explorerContainerId found in DB', async function () {
        const lastStatus = {
            '': {
                '': {
                    'xchain-explorer': {
                        status: { State: { Status: 'running' } }
                    }
                }
            }
        }
        const stubs = makeExplorerServiceStubs({
            getLastStatus: sinon.stub().returns(lastStatus),
            dbGetModuleContainer: sinon.stub().resolves(null),   // no container id
            getInstalledCoinsAndNetworks: sinon.stub().resolves({
                bitcoin: ['mainnet']
            })
        })
        const es = loadExplorerService(stubs)
        const result = await es.updateExplorer()
        expect(result).to.be.true
        expect(stubs.addContainerToNetwork.called).to.be.false
    })
})
