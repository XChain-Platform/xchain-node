'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { Coin, Network } = require('../../src/config/constants')

const TestEnv        = require('./helpers/test-env')
const CommandCapture = require('./helpers/command-capture')

describe('Integration: Docker Network Management', function () {
    this.timeout(15000)

    let env, capture

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
        capture = new CommandCapture()
    })

    afterEach(async function () {
        await env.teardown()
    })

    function makeDockerService() {
        return proxyquire('../../src/services/DockerService', {
            'child_process': {
                exec: capture.createExecStub(),
                spawn: capture.createSpawnStub(),
                spawnSync: capture.createSpawnSyncStub()
            },
            'blessed': {
                screen: () => ({
                    key: () => {},
                    on: () => {},
                    render: () => {},
                    destroy: () => {}
                }),
                text: () => {},
                log: () => ({ log: () => {} })
            }
        })
    }

    // ---------------------------------------------------------------
    // createDockerNetwork
    // ---------------------------------------------------------------

    describe('createDockerNetwork', function () {

        it('creates network when it does not exist', async function () {
            capture.when(/docker network inspect xchain-node-bitcoin-mainnet/).returns({
                error: new Error('Network not found')
            })
            capture.when(/docker network create/).returns({ stdout: '' })

            const DockerService = makeDockerService()
            const result = await DockerService.createDockerNetwork('xchain-node-bitcoin-mainnet')

            expect(result).to.be.true
            capture.assertCalled(/docker network create xchain-node-bitcoin-mainnet/)
        })

        it('skips creation when network already exists', async function () {
            capture.when(/docker network inspect xchain-node-bitcoin-mainnet/).returns({
                stdout: JSON.stringify([{ Name: 'xchain-node-bitcoin-mainnet' }])
            })

            const DockerService = makeDockerService()
            const result = await DockerService.createDockerNetwork('xchain-node-bitcoin-mainnet')

            expect(result).to.be.true
            capture.assertNotCalled(/docker network create/)
        })

        it('creates base network xchain-node', async function () {
            capture.when(/docker network inspect xchain-node$/).returns({
                error: new Error('Network not found')
            })
            capture.when(/docker network create/).returns({ stdout: '' })

            const DockerService = makeDockerService()
            await DockerService.createDockerNetwork('xchain-node')

            capture.assertCalled(/docker network create xchain-node/)
        })
    })

    // ---------------------------------------------------------------
    // addContainerToNetwork
    // ---------------------------------------------------------------

    describe('addContainerToNetwork', function () {

        it('connects container when not already on network', async function () {
            const containerId = TestEnv.fakeContainerId('c')

            capture.when(/docker inspect/).returns({
                stdout: JSON.stringify([{
                    State: { Status: 'running' },
                    NetworkSettings: {
                        Networks: {
                            'xchain-node': {}
                        }
                    }
                }])
            })
            capture.when(/docker network connect/).returns({ stdout: '' })

            const DockerService = makeDockerService()
            const result = await DockerService.addContainerToNetwork(containerId, 'xchain-node-bitcoin-mainnet')

            expect(result).to.be.true
            capture.assertCalled(/docker network connect xchain-node-bitcoin-mainnet/)
        })

        it('skips connection when already on network', async function () {
            const containerId = TestEnv.fakeContainerId('c')

            capture.when(/docker inspect/).returns({
                stdout: JSON.stringify([{
                    State: { Status: 'running' },
                    NetworkSettings: {
                        Networks: {
                            'xchain-node': {},
                            'xchain-node-bitcoin-mainnet': {}
                        }
                    }
                }])
            })

            const DockerService = makeDockerService()
            const result = await DockerService.addContainerToNetwork(containerId, 'xchain-node-bitcoin-mainnet')

            expect(result).to.be.true
            capture.assertNotCalled(/docker network connect/)
        })
    })

    // ---------------------------------------------------------------
    // Container lifecycle commands
    // ---------------------------------------------------------------

    describe('container lifecycle commands', function () {

        it('startContainer calls docker start with correct ID', async function () {
            const containerId = TestEnv.fakeContainerId('s')
            capture.when(/docker start/).returns({ stdout: containerId })

            const DockerService = makeDockerService()
            const result = await DockerService.startContainer(containerId)

            expect(result).to.be.true
            const cmds = capture.assertCalled(/docker start/)
            expect(cmds[0].command).to.include(containerId)
        })

        it('stopContainer calls docker stop with correct ID', async function () {
            const containerId = TestEnv.fakeContainerId('t')
            capture.when(/docker stop/).returns({ stdout: containerId })

            const DockerService = makeDockerService()
            const result = await DockerService.stopContainer(containerId)

            expect(result).to.be.true
            capture.assertCalled(/docker stop/)
        })

        it('restartContainer calls docker restart with correct ID', async function () {
            const containerId = TestEnv.fakeContainerId('r')
            capture.when(/docker restart/).returns({ stdout: containerId })

            const DockerService = makeDockerService()
            const result = await DockerService.restartContainer(containerId)

            expect(result).to.be.true
            capture.assertCalled(/docker restart/)
        })

        it('removeContainer calls docker rm with correct ID', async function () {
            const containerId = TestEnv.fakeContainerId('m')
            capture.when(/docker rm/).returns({ stdout: containerId })

            const DockerService = makeDockerService()
            const result = await DockerService.removeContainer(containerId)

            expect(result).to.be.true
            capture.assertCalled(/docker rm/)
        })

        it('killContainer calls docker kill with correct ID', async function () {
            const containerId = TestEnv.fakeContainerId('k')
            capture.when(/docker kill/).returns({ stdout: containerId })

            const DockerService = makeDockerService()
            const result = await DockerService.killContainer(containerId)

            expect(result).to.be.true
            capture.assertCalled(/docker kill/)
        })

        it('execContainer calls docker exec with correct command', async function () {
            const containerId = TestEnv.fakeContainerId('x')
            capture.when(/docker exec/).returns({ stdout: 'command output' })

            const DockerService = makeDockerService()
            const result = await DockerService.execContainer(containerId, 'ls -la')

            expect(result).to.equal('command output')
            const cmds = capture.assertCalled(/docker exec/)
            expect(cmds[0].command).to.include(containerId)
            expect(cmds[0].command).to.include('ls -la')
        })
    })

    // ---------------------------------------------------------------
    // checkDockerInstalledAndReachable
    // ---------------------------------------------------------------

    describe('checkDockerInstalledAndReachable', function () {

        it('resolves when docker --version and docker ps succeed', async function () {
            capture.when(/docker --version/).returns({ stdout: 'Docker version 24.0.7, build afdd53b' })
            capture.when(/docker ps/).returns({ stdout: '' })

            const DockerService = makeDockerService()
            const result = await DockerService.checkDockerInstalledAndReachable()
            expect(result).to.be.true
        })

        it('rejects when docker --version fails', async function () {
            capture.when(/docker --version/).returns({ error: new Error('not found') })

            const DockerService = makeDockerService()
            try {
                await DockerService.checkDockerInstalledAndReachable()
                expect.fail('Should have rejected')
            } catch (err) {
                expect(err).to.include('docker --version')
            }
        })

        it('rejects when docker ps fails (not in docker group)', async function () {
            capture.when(/docker --version/).returns({ stdout: 'Docker version 24.0.7, build afdd53b' })
            capture.when(/docker ps/).returns({ error: new Error('permission denied') })

            const DockerService = makeDockerService()
            try {
                await DockerService.checkDockerInstalledAndReachable()
                expect.fail('Should have rejected')
            } catch (err) {
                expect(err).to.include('docker ps')
            }
        })
    })

    // ---------------------------------------------------------------
    // getStatusFromContainer
    // ---------------------------------------------------------------

    describe('getStatusFromContainer', function () {

        it('parses docker inspect JSON and returns first element', async function () {
            const containerId = TestEnv.fakeContainerId('i')
            const inspectResult = [{
                State: { Status: 'running' },
                NetworkSettings: { Ports: { '3003/tcp': [{ HostIp: '0.0.0.0', HostPort: '3003' }] } }
            }]
            capture.when(/docker inspect/).returns({ stdout: JSON.stringify(inspectResult) })

            const DockerService = makeDockerService()
            const result = await DockerService.getStatusFromContainer(containerId)

            expect(result.State.Status).to.equal('running')
            expect(result.NetworkSettings.Ports['3003/tcp']).to.have.length(1)
        })
    })
})
