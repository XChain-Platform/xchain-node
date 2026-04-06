'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const TestEnv = require('./helpers/test-env')

describe('Integration: Status Query Chain', function () {
    this.timeout(15000)

    let env

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
    })

    afterEach(async function () {
        await env.teardown()
    })

    function makeDockerInspectResponse(status, ports) {
        return JSON.stringify([{
            State: { Status: status },
            NetworkSettings: {
                Ports: ports || {}
            }
        }])
    }

    /**
     * Create a StatusService with stubbed DockerService (docker inspect)
     * and stubbed VersionService, but real LevelDB interaction.
     */
    function makeStatusService(inspectResponses) {
        return proxyquire('../../src/services/StatusService', {
            './DockerService': {
                getStatusFromContainer: async (containerId) => {
                    if (containerId in inspectResponses) {
                        return inspectResponses[containerId]
                    }
                    throw new Error('Container not found: ' + containerId)
                }
            },
            './VersionService': {
                checkRemoteNodeVersion: async () => {},
                getLocalNodeVersion: async () => '0.0.1',
                getContainerNodeVersion: async () => '0.0.1',
                getLocalModuleVersion: async () => '0.0.1',
                getContainerModuleVersion: async () => '0.0.1'
            }
        })
    }

    // ---------------------------------------------------------------
    // Status for installed running modules
    // ---------------------------------------------------------------

    describe('getStatus with installed modules', function () {

        it('returns running status for installed module', async function () {
            const containerId = TestEnv.fakeContainerId('a')
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            const inspectResponses = {}
            inspectResponses[containerId] = {
                State: { Status: 'running' },
                NetworkSettings: {
                    Ports: { '3003/tcp': [{ HostIp: '0.0.0.0', HostPort: '3003' }] }
                }
            }

            const StatusService = makeStatusService(inspectResponses)
            const result = await StatusService.getStatus(null, null, false)

            expect(result).to.have.property('bitcoin')
            expect(result['bitcoin']).to.have.property('mainnet')
            expect(result['bitcoin']['mainnet']).to.have.property('xchain-encoder')
            expect(result['bitcoin']['mainnet']['xchain-encoder']['status']['State']['Status']).to.equal('running')
            expect(result['bitcoin']['mainnet']['xchain-encoder']['container_id']).to.equal(containerId)
        })

        it('returns exited status for stopped module', async function () {
            const containerId = TestEnv.fakeContainerId('b')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const inspectResponses = {}
            inspectResponses[containerId] = {
                State: { Status: 'exited' },
                NetworkSettings: { Ports: {} }
            }

            const StatusService = makeStatusService(inspectResponses)
            const result = await StatusService.getStatus(null, null, false)

            expect(result['bitcoin']['mainnet']['xchain-decoder']['status']['State']['Status']).to.equal('exited')
        })

        it('returns multiple modules across different coins/networks', async function () {
            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')
            const id3 = TestEnv.fakeContainerId('3')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await env.insertModule('xchain-decoder', 'dogecoin', 'testnet', id2)
            await env.insertModule('xchain-hub', '', '', id3)

            const inspectResponses = {}
            inspectResponses[id1] = { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }
            inspectResponses[id2] = { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }
            inspectResponses[id3] = { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }

            const StatusService = makeStatusService(inspectResponses)
            const result = await StatusService.getStatus(null, null, false)

            expect(result).to.have.property('bitcoin')
            expect(result).to.have.property('dogecoin')
            expect(result).to.have.property('')
            expect(result['bitcoin']['mainnet']).to.have.property('xchain-encoder')
            expect(result['dogecoin']['testnet']).to.have.property('xchain-decoder')
            expect(result['']['']['xchain-hub']).to.exist
        })
    })

    // ---------------------------------------------------------------
    // Status with no modules
    // ---------------------------------------------------------------

    describe('getStatus with empty LevelDB', function () {

        it('returns empty object and does not throw', async function () {
            const StatusService = makeStatusService({})
            const result = await StatusService.getStatus(null, null, false)
            expect(result).to.deep.equal({})
        })
    })

    // ---------------------------------------------------------------
    // Status when Docker inspect fails
    // ---------------------------------------------------------------

    describe('getStatus when Docker inspect fails', function () {

        it('removes modules that fail inspection from result', async function () {
            const goodId = TestEnv.fakeContainerId('g')
            const badId = TestEnv.fakeContainerId('x')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', goodId)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', badId)

            const inspectResponses = {}
            inspectResponses[goodId] = { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }
            // badId will throw (not in inspectResponses)

            const StatusService = makeStatusService(inspectResponses)
            const result = await StatusService.getStatus(null, null, false)

            // Good module present, bad module removed
            expect(result['bitcoin']['mainnet']).to.have.property('xchain-encoder')
            expect(result['bitcoin']['mainnet']).to.not.have.property('xchain-decoder')
        })

        it('removes entire coin/network when all modules fail inspection', async function () {
            const badId = TestEnv.fakeContainerId('x')
            await env.insertModule('xchain-encoder', 'litecoin', 'testnet', badId)

            const StatusService = makeStatusService({})
            const result = await StatusService.getStatus(null, null, false)

            // Entire litecoin/testnet should be cleaned up
            if (result['litecoin']) {
                expect(result['litecoin']).to.not.have.property('testnet')
            }
        })
    })

    // ---------------------------------------------------------------
    // Status caching
    // ---------------------------------------------------------------

    describe('status caching', function () {

        it('second call returns cached result without re-querying Docker', async function () {
            const containerId = TestEnv.fakeContainerId('c')
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            let inspectCount = 0
            const StatusService = proxyquire('../../src/services/StatusService', {
                './DockerService': {
                    getStatusFromContainer: async () => {
                        inspectCount++
                        return { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }
                    }
                },
                './VersionService': {
                    checkRemoteNodeVersion: async () => {},
                    getLocalNodeVersion: async () => '0.0.1',
                    getContainerNodeVersion: async () => '0.0.1',
                    getLocalModuleVersion: async () => '0.0.1',
                    getContainerModuleVersion: async () => '0.0.1'
                }
            })

            // First call queries Docker
            await StatusService.getStatus(null, null, false)
            const firstCount = inspectCount

            // Second call uses cache
            await StatusService.getStatus(null, null, false)
            expect(inspectCount).to.equal(firstCount)
        })
    })

    // ---------------------------------------------------------------
    // getInstalledCoinsAndNetworks
    // ---------------------------------------------------------------

    describe('getInstalledCoinsAndNetworks', function () {

        it('returns installed coins and their networks', async function () {
            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await env.insertModule('xchain-decoder', 'bitcoin', 'testnet', id2)

            const inspectResponses = {}
            inspectResponses[id1] = { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }
            inspectResponses[id2] = { State: { Status: 'running' }, NetworkSettings: { Ports: {} } }

            const StatusService = makeStatusService(inspectResponses)

            // getStatus first to populate state
            await StatusService.getStatus(null, null, false)

            const result = await StatusService.getInstalledCoinsAndNetworks()
            expect(result).to.have.property('bitcoin')
            expect(result['bitcoin']).to.include('mainnet')
            expect(result['bitcoin']).to.include('testnet')
        })
    })
})
