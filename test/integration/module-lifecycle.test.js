'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const TestEnv = require('./helpers/test-env')
const CommandCapture = require('./helpers/command-capture')

describe('Integration: Module Lifecycle (LevelDB state)', function () {
    this.timeout(15000)

    let env

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
    })

    afterEach(async function () {
        await env.teardown()
    })

    // ---------------------------------------------------------------
    // Direct LevelDB operations via state.db
    // ---------------------------------------------------------------

    describe('LevelDB key format and CRUD', function () {
        const state = require('../../src/state')

        it('insertModuleContainer stores and getModuleContainer retrieves by MC key', async function () {
            const containerId = TestEnv.fakeContainerId('a')
            const result = await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', containerId)
            expect(result).to.be.true

            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.equal(containerId)
        })

        it('getModuleContainer returns null for non-existent key', async function () {
            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.be.null
        })

        it('removeModuleContainer deletes the entry', async function () {
            const containerId = TestEnv.fakeContainerId('b')
            await state.db.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const removed = await state.db.removeModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')
            expect(removed).to.equal(containerId)

            const retrieved = await state.db.getModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.be.null
        })

        it('getAllModuleContainers returns all entries for a coin/network', async function () {
            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')
            const id3 = TestEnv.fakeContainerId('3')

            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await state.db.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', id2)
            await state.db.insertModuleContainer('xchain-encoder', 'litecoin', 'mainnet', id3)

            // Filter by bitcoin/mainnet
            const btcModules = await state.db.getAllModuleContainers('bitcoin', 'mainnet')
            expect(btcModules).to.have.length(2)
            expect(btcModules.map(m => m.module)).to.include.members(['xchain-encoder', 'xchain-decoder'])

            // Get all (null/null)
            const allModules = await state.db.getAllModuleContainers(null, null)
            expect(allModules).to.have.length(3)
        })

        it('getAllModuleContainers always returns shared services (empty coin/network)', async function () {
            const hubId = TestEnv.fakeContainerId('h')
            const encoderId = TestEnv.fakeContainerId('e')

            await state.db.insertModuleContainer('xchain-hub', '', '', hubId)
            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', encoderId)

            // When filtering by bitcoin/mainnet, shared services (empty coin/network) are also returned
            const modules = await state.db.getAllModuleContainers('bitcoin', 'mainnet')
            const moduleNames = modules.map(m => m.module)
            expect(moduleNames).to.include('xchain-hub')
            expect(moduleNames).to.include('xchain-encoder')
        })

        it('insertModuleContainer overwrites existing entry', async function () {
            const oldId = TestEnv.fakeContainerId('x')
            const newId = TestEnv.fakeContainerId('y')

            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', oldId)
            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', newId)

            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.equal(newId)
        })
    })

    // ---------------------------------------------------------------
    // Multiple modules maintain separate state
    // ---------------------------------------------------------------

    describe('multi-module state isolation', function () {
        const state = require('../../src/state')

        it('three modules on same coin/network have independent entries', async function () {
            const encId = TestEnv.fakeContainerId('e')
            const decId = TestEnv.fakeContainerId('d')
            const idxId = TestEnv.fakeContainerId('i')

            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', encId)
            await state.db.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', decId)
            await state.db.insertModuleContainer('xchain-indexer', 'bitcoin', 'mainnet', idxId)

            // Verify each
            expect(await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')).to.equal(encId)
            expect(await state.db.getModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')).to.equal(decId)
            expect(await state.db.getModuleContainer('xchain-indexer', 'bitcoin', 'mainnet')).to.equal(idxId)

            // Remove one
            await state.db.removeModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')

            // Others still intact
            expect(await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')).to.equal(encId)
            expect(await state.db.getModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')).to.be.null
            expect(await state.db.getModuleContainer('xchain-indexer', 'bitcoin', 'mainnet')).to.equal(idxId)
        })

        it('same module on different coin/network combos are independent', async function () {
            const btcId = TestEnv.fakeContainerId('b')
            const ltcId = TestEnv.fakeContainerId('l')
            const dogeId = TestEnv.fakeContainerId('d')

            await state.db.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', btcId)
            await state.db.insertModuleContainer('xchain-encoder', 'litecoin', 'mainnet', ltcId)
            await state.db.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', dogeId)

            expect(await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')).to.equal(btcId)
            expect(await state.db.getModuleContainer('xchain-encoder', 'litecoin', 'mainnet')).to.equal(ltcId)
            expect(await state.db.getModuleContainer('xchain-encoder', 'dogecoin', 'testnet')).to.equal(dogeId)
        })
    })

    // ---------------------------------------------------------------
    // moduleOperations -> LevelDB interaction (start/stop/restart)
    // ---------------------------------------------------------------

    describe('moduleOperations uses LevelDB for container lookups', function () {

        it('startModules reads container IDs from LevelDB and calls docker start', async function () {
            const capture = env.cmdCapture
            capture.when(/docker start/).returns({ stdout: TestEnv.fakeContainerId('a') })

            const containerId = TestEnv.fakeContainerId('a')
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            // Use proxyquire to inject our stubs into the operation chain
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    startContainer: async (id) => {
                        capture._history.push({ command: 'docker start ' + id, type: 'exec', options: {} })
                        return true
                    },
                    createDockerNetwork: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
            await moduleOps.startModules(serviceList)

            const startCmds = capture.findCommands(/docker start/)
            expect(startCmds).to.have.length(1)
            expect(startCmds[0].command).to.include(containerId)
        })

        it('stopModules reads container IDs from LevelDB and calls docker stop', async function () {
            const capture = env.cmdCapture
            const containerId = TestEnv.fakeContainerId('s')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    stopContainer: async (id) => {
                        capture._history.push({ command: 'docker stop ' + id, type: 'exec', options: {} })
                        return true
                    },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.stopModules(serviceList)

            const stopCmds = capture.findCommands(/docker stop/)
            expect(stopCmds).to.have.length(1)
            expect(stopCmds[0].command).to.include(containerId)
        })

        it('stopModules handles multiple modules across coin/networks', async function () {
            const capture = env.cmdCapture
            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')
            const id3 = TestEnv.fakeContainerId('3')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', id2)
            await env.insertModule('xchain-encoder', 'litecoin', 'testnet', id3)

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    stopContainer: async (id) => {
                        capture._history.push({ command: 'docker stop ' + id, type: 'exec', options: {} })
                        return true
                    },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = {
                'bitcoin':  { 'mainnet': ['xchain-encoder', 'xchain-decoder'] },
                'litecoin': { 'testnet': ['xchain-encoder'] }
            }
            await moduleOps.stopModules(serviceList)

            const stopCmds = capture.findCommands(/docker stop/)
            expect(stopCmds).to.have.length(3)
        })

        it('startModules gracefully handles missing LevelDB entry', async function () {
            // No modules inserted — LevelDB is empty
            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    startContainer: sinon.stub().resolves(true),
                    createDockerNetwork: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
            // Should not throw — the operation catches errors and logs them
            const result = await moduleOps.startModules(serviceList)
            expect(result).to.be.true
        })

        it('restartModules reads IDs and calls docker restart', async function () {
            const restartedIds = []
            const containerId = TestEnv.fakeContainerId('r')
            await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', containerId)

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    restartContainer: async (id) => { restartedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/StatusService': {
                    statusChanged: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-indexer'] } }
            await moduleOps.restartModules(serviceList)

            expect(restartedIds).to.have.length(1)
            expect(restartedIds[0]).to.equal(containerId)
        })

        it('execModules reads container ID and executes command', async function () {
            const execCalls = []
            const containerId = TestEnv.fakeContainerId('x')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    execContainer: async (id, cmd) => { execCalls.push({ id, cmd }); return 'output' },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.execModules(serviceList, 'ls -la')

            expect(execCalls).to.have.length(1)
            expect(execCalls[0].id).to.equal(containerId)
            expect(execCalls[0].cmd).to.equal('ls -la')
        })
    })
})
