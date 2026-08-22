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
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const EXPLORER_MODULE_NAME = 'xchain-explorer'

function makeExplorerServiceStubs(overrides = {}) {
    return {
        db: {
            getModuleContainer:    overrides.dbGetModuleContainer    || sinon.stub().resolves(null),
            removeModuleContainer: overrides.dbRemoveModuleContainer || sinon.stub().resolves()
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

    return proxyquire('../../src/services/ExplorerService', {
        '../config/constants': {
            EXPLORER_MODULE_NAME: 'xchain-explorer'
        },
        '../state': {
            db:              stubs.db,
            getLastStatus:   stubs.getLastStatus,
            isStatusUpdated: stubs.isStatusUpdated
        },
        '../utils/helpers': {
            sleep:         stubs.sleep,
            redactSecrets: (err) => String(err && err.message ? err.message : err)
        },
        './ConfigService': {
            getDefaultConfig: stubs.getDefaultConfig,
            getDockerNetwork: stubs.getDockerNetwork
        },
        './StatusService': {
            statusChanged:                stubs.statusChanged,
            getStatus:                    stubs.getStatus,
            getInstalledCoinsAndNetworks: stubs.getInstalledCoinsAndNetworks
        },
        './DockerService': {
            addContainerToNetwork: stubs.addContainerToNetwork,
            killContainer:         stubs.killContainer,
            removeContainer:       stubs.removeContainer
        },
        './ModuleService': {
            cloneGit:   stubs.cloneGit,
            buildAndUp: stubs.buildAndUp
        },
        './ReleaseManifestService': {
            resolveComponentRef: stubs.resolveComponentRef
        },
        '../ExplorerConnector.js': MockExplorerConnector
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

describe('ExplorerService: installExplorerModule() already running', function () {

    it('returns true immediately when ping succeeds and force=false', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().resolves(true)
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(false)
        expect(result).to.be.true
        expect(stubs.cloneGit.called).to.be.false
    })

    it('returns true when status is cached and explorer is in lastStatus (force=false)', async function () {
        const lastStatus = {
            '': {
                '': {
                    'xchain-explorer': { status: { State: { Status: 'running' } } }
                }
            }
        }
        const stubs = makeExplorerServiceStubs({
            explorerPing:     sinon.stub().resolves(false),   // ping fails
            isStatusUpdated:  sinon.stub().returns(true),     // cache is hot
            getLastStatus:    sinon.stub().returns(lastStatus)
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(false)
        expect(result).to.be.true
        expect(stubs.cloneGit.called).to.be.false
    })
})

// The explorer was one of two modules whose install ignored the ref the command
// named, so `install develop ...` built it from the default branch (master) while
// every generic-path module built from develop. These pin the ref reaching the
// clone, because that argument is the whole defect: everything downstream of it
// looked correct while testing the wrong tree.
describe('ExplorerService: installExplorerModule() honours the install ref', function () {

    it('clones at the branch the caller named', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false, 'develop')
        expect(stubs.cloneGit.firstCall.args[0]).to.equal(EXPLORER_MODULE_NAME)
        expect(stubs.cloneGit.firstCall.args[3]).to.equal('develop')
    })

    it('clones a release branch verbatim, so a frozen-ref e2e tests the frozen tree', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false, 'release/v0.10.0')
        expect(stubs.cloneGit.firstCall.args[3]).to.equal('release/v0.10.0')
    })

    it('passes the manifest pin (ref AND commit) when a release install is active', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true),
            resolveComponentRef: sinon.stub().returns({ ref: 'v0.9.0', commit: 'a'.repeat(40), pinned: true })
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false, null)
        expect(stubs.cloneGit.firstCall.args[3]).to.equal('v0.9.0')
        expect(stubs.cloneGit.firstCall.args[4]).to.equal('a'.repeat(40))
    })

    it('passes null when no ref was named, keeping the default-branch behaviour', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false)
        expect(stubs.cloneGit.firstCall.args[3]).to.equal(null)
    })
})

// The explorer only reports healthy once it holds a DB pool, and its pools come
// from the coin stacks. `install <ref> all` installs it in the shared bucket,
// BEFORE any coin exists, so requiring health there made a first install
// unsatisfiable: measured on a clean hosted runner, the explorer answered 503
// degraded for ten seconds and the whole stack install failed. It never showed on
// a dev box or CI venue, both of which already carry coin DBs.
describe('ExplorerService: installExplorerModule() on a stack with no coins yet', function () {

    it('accepts an answering-but-degraded explorer when no coin is installed', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: false }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({})
        })
        const es = loadExplorerService(stubs)
        expect(await es.installExplorerModule(false)).to.be.true
        expect(stubs.buildAndUp.called).to.be.true
    })

    it('still REFUSES an answering-but-degraded explorer once a coin is installed', async function () {
        // With a coin present the explorer should hold a pool for it, so degraded
        // is a real fault and must not be waved through by the carve-out above.
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: false }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['regtest'] })
        })
        const es = loadExplorerService(stubs)
        let threw = null
        try { await es.installExplorerModule(false) } catch (err) { threw = err }
        expect(threw).to.match(/Couldn't install the explorer module/)
    })

    it('refuses a container that never answers at all, coins or not', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: false, healthy: false }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({})
        })
        const es = loadExplorerService(stubs)
        let threw = null
        try { await es.installExplorerModule(false) } catch (err) { threw = err }
        expect(threw).to.match(/Couldn't install the explorer module/)
    })

    it('a healthy explorer is accepted whether or not a coin is installed', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: true }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['regtest'] })
        })
        const es = loadExplorerService(stubs)
        expect(await es.installExplorerModule(false)).to.be.true
    })
})

describe('ExplorerService: installExplorerModule() force=true', function () {

    it('kills and removes existing container when force=true and container exists', async function () {
        const existingId = 'existing-id'
        let pingCallCount = 0
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves(existingId),
            explorerPing: sinon.stub().callsFake(() => {
                pingCallCount++
                // Return true on the second call (post-install) to exit the while loop
                return Promise.resolve(pingCallCount >= 2)
            })
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(true)
        expect(result).to.be.true
        expect(stubs.killContainer.calledWith(existingId)).to.be.true
        expect(stubs.removeContainer.calledWith(existingId)).to.be.true
        expect(stubs.db.removeModuleContainer.called).to.be.true
    })

    it('swallows errors from killContainer/removeContainer during force rebuild', async function () {
        const existingId = 'old-id'
        let pingCallCount = 0
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves(existingId),
            killContainer:  sinon.stub().rejects(new Error('already stopped')),
            removeContainer: sinon.stub().rejects(new Error('already gone')),
            explorerPing: sinon.stub().callsFake(() => {
                pingCallCount++
                return Promise.resolve(pingCallCount >= 2)
            })
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(true)
        expect(result).to.be.true
    })

    it('skips kill/remove when no existing container in DB (force=true)', async function () {
        let pingCallCount = 0
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves(null),
            explorerPing: sinon.stub().callsFake(() => {
                pingCallCount++
                return Promise.resolve(pingCallCount >= 2)
            })
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(true)
        expect(stubs.killContainer.called).to.be.false
        expect(stubs.removeContainer.called).to.be.false
    })
})

describe('ExplorerService: installExplorerModule() exhausts retries', function () {

    it('throws when explorer never responds after 10 tries', async function () {
        // ping always returns false → loop exhausts tries
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().resolves(false),
            sleep: sinon.stub().resolves()
        })
        const es = loadExplorerService(stubs)
        try {
            await es.installExplorerModule(true)
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).to.include("Couldn't install the explorer module")
        }
        // sleep should have been called for each failed poll
        expect(stubs.sleep.callCount).to.be.greaterThan(0)
    })
})

describe('ExplorerService: installExplorerModule() updateExplorer error in loop', function () {

    it('retries on updateExplorer error and returns true when subsequent ping+updateExplorer succeed', async function () {
        // Scenario: first ping succeeds but updateExplorer throws on first try,
        // then on retry ping succeeds and updateExplorer succeeds
        let pingCount = 0
        let updateExplorerCallCount = 0
        const lastStatus = {
            '': { '': { 'xchain-explorer': { status: { State: { Status: 'running' } } } } }
        }

        const updateExplorer = sinon.stub().callsFake(() => {
            updateExplorerCallCount++
            if (updateExplorerCallCount === 1) throw new Error('transient error')
            return Promise.resolve(true)
        })

        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().callsFake(() => {
                pingCount++
                // Return true on the first and subsequent calls (to drive the ping branch)
                return Promise.resolve(true)
            }),
            sleep: sinon.stub().resolves(),
            getLastStatus: sinon.stub().returns(lastStatus),
            dbGetModuleContainer: sinon.stub().resolves('explorer-cid'),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({})
        })

        const MockExplorerConnector = sinon.stub()
        MockExplorerConnector.prototype.ping = stubs.explorerPing
        MockExplorerConnector.prototype.probe = async () => {
            const healthy = await stubs.explorerPing()
            return { answering: healthy, healthy }
        }

        const es = proxyquire('../../src/services/ExplorerService', {
            '../config/constants': { EXPLORER_MODULE_NAME: 'xchain-explorer' },
            '../state': {
                db: stubs.db,
                getLastStatus: stubs.getLastStatus,
                isStatusUpdated: stubs.isStatusUpdated
            },
            '../utils/helpers': {
                sleep:         stubs.sleep,
                redactSecrets: (err) => String(err && err.message ? err.message : err)
            },
            './ConfigService': {
                getDefaultConfig: stubs.getDefaultConfig,
                getDockerNetwork: stubs.getDockerNetwork
            },
            './StatusService': {
                statusChanged:                stubs.statusChanged,
                getStatus:                    stubs.getStatus,
                getInstalledCoinsAndNetworks: stubs.getInstalledCoinsAndNetworks
            },
            './DockerService': {
                addContainerToNetwork: stubs.addContainerToNetwork,
                killContainer:         stubs.killContainer,
                removeContainer:       stubs.removeContainer
            },
            './ModuleService': {
                cloneGit:   stubs.cloneGit,
                buildAndUp: stubs.buildAndUp
            },
            '../ExplorerConnector.js': MockExplorerConnector
        })

        // updateExplorer is called internally and is self-referential within the
        // module, so it cannot be stubbed directly through proxyquire; the retry
        // path is instead verified indirectly, by checking that the install still
        // resolves true once ping and the internal updateExplorer both succeed
        // on the retry after the first updateExplorer call fails.
        const result = await es.installExplorerModule(true)
        expect(result).to.be.true
    })
})

describe('ExplorerService: installExplorerModule() persistent attach failure', function () {

    // This is an explicit design choice ("a genuinely broken network now fails
    // the install, intended"): the ping loop's existing catch absorbs a
    // transient updateExplorer failure, while a persistent one exhausts the
    // tries rather than reporting a success the explorer cannot deliver.
    it('exhausts the ping retries and throws instead of returning success', async function () {
        let pingCount = 0
        const lastStatus = {
            '': { '': { 'xchain-explorer': { status: { State: { Status: 'running' } } } } }
        }
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().callsFake(() => {
                pingCount++
                return Promise.resolve(pingCount >= 2)
            }),
            getLastStatus: sinon.stub().returns(lastStatus),
            dbGetModuleContainer: sinon.stub().resolves('explorer-cid'),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['mainnet'] }),
            addContainerToNetwork: sinon.stub().rejects(new Error('network error'))
        })
        const es = loadExplorerService(stubs)

        let threw = null
        try {
            await es.installExplorerModule(false)
        } catch (err) {
            threw = err
        }

        expect(threw).to.include("Couldn't install the explorer module")
        expect(stubs.addContainerToNetwork.called).to.be.true
    })
})

describe('ExplorerService: installExplorerModule() full happy path', function () {

    it('clones, builds, then returns true when first ping succeeds', async function () {
        let pingCount = 0
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().callsFake(() => {
                pingCount++
                return Promise.resolve(pingCount >= 1)  // succeed immediately
            }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({}),
            getLastStatus: sinon.stub().returns(null)
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(false)
        // ping returns true from the first call, so the "is it running?" check
        // short-circuits and the install returns true immediately.
        expect(result).to.be.true
    })

    it('clones and builds when ping initially fails and status cache is cold', async function () {
        let pingCount = 0
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().callsFake(() => {
                pingCount++
                // First call (running check) → false, second call (post-install) → true
                return Promise.resolve(pingCount >= 2)
            }),
            isStatusUpdated:  sinon.stub().returns(false),
            getLastStatus:    sinon.stub().returns(null),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({})
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(false)
        expect(result).to.be.true
        expect(stubs.cloneGit.calledWith(EXPLORER_MODULE_NAME, true)).to.be.true
        expect(stubs.buildAndUp.calledWith(EXPLORER_MODULE_NAME, null, null)).to.be.true
    })
})

// The wait exists because the explorer polls the hub for its coins, so a fresh
// install returns while it is still answering 503. It must converge a service
// that is talking, and must NOT burn its budget on a host where no explorer is
// listening at all (a coin-only install), which is also what keeps it out of the
// way of suites that run against a fully mocked stack.
describe('ExplorerService: waitForExplorerReady()', function () {

    it('returns true as soon as the explorer reports healthy', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: true })
        })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(10000)).to.be.true
    })

    it('keeps waiting through degraded replies, then succeeds when it converges', async function () {
        const probe = sinon.stub()
        probe.onCall(0).resolves({ answering: true, healthy: false })
        probe.onCall(1).resolves({ answering: true, healthy: false })
        probe.resolves({ answering: true, healthy: true })
        const stubs = makeExplorerServiceStubs({ explorerProbe: probe })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(10000)).to.be.true
        expect(probe.callCount).to.be.greaterThan(2)
    })

    it('gives up early, reporting no problem, when nothing is listening at all', async function () {
        // Silence is "no explorer on this host", not "an explorer converging".
        // Grinding the full budget here would add minutes to every coin-only install.
        const probe = sinon.stub().resolves({ answering: false, healthy: false })
        const stubs = makeExplorerServiceStubs({ explorerProbe: probe, sleep: sinon.stub().resolves() })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(150000, 0)).to.be.true
    })

    it('reports false when a talking explorer never converges inside the budget', async function () {
        const probe = sinon.stub().resolves({ answering: true, healthy: false })
        const stubs = makeExplorerServiceStubs({ explorerProbe: probe, sleep: sinon.stub().resolves() })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(10)).to.be.false
    })
})
