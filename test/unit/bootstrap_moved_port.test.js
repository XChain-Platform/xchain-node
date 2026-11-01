'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const {
    configDir,
    coinMain,
    coinSidecar,
    makeMemoryConfigService,
    XChainService
} = require('./config_service.test/helpers.test')
const constants = require('../../src/config')
const { buildHubModuleConfig } = require('../../src/services/hub_service/hub_module_config')

const FIRST_TRACKER = 'xchain-node-bitcoin-testnet-xchain-utxo-tracker'
const SECOND_TRACKER = 'xchain-node-bitcoin-mainnet-xchain-utxo-tracker'
const hostPortClaimPath = require.resolve('../../src/services/module_service/host_port_claim')
const bootstrapGuardPath = require.resolve('../../src/services/bootstrap_node_tip_guard')
const dockerArgsPath = require.resolve('../../src/services/module_service/docker_args')

let baseClaimFreeHostPorts

function loadDockerArgs(published) {
    return proxyquire('../../src/services/module_service/docker_args', {
        'fs': {},
        'path': {},
        '../../config': constants,
        '../config_service': { getUtxoTrackerVolumeName: () => 'tracker-volume' },
        '../docker_service': { getPublishedHostPorts: async () => published },
        './healthcheck_command': { healthcheckCommand: () => '' },
        '../validator_service': {},
        '../observability/logger': { getLogger: () => ({ info: () => {} }) }
    })
}

function installProductionWrapper(memory, published) {
    const hostPortClaim = require(hostPortClaimPath)
    baseClaimFreeHostPorts = hostPortClaim.claimFreeHostPorts.baseClaimFreeHostPorts ||
        hostPortClaim.claimFreeHostPorts
    hostPortClaim.claimFreeHostPorts = baseClaimFreeHostPorts
    delete require.cache[bootstrapGuardPath]
    delete require.cache[dockerArgsPath]

    proxyquire('../../src/services/bootstrap_node_tip_guard', {
        'fs': { readFileSync: file => memory.files[file] || '' },
        './config_service': memory.cs
    })

    expect(hostPortClaim.claimFreeHostPorts).not.to.equal(baseClaimFreeHostPorts)
    expect(hostPortClaim.claimFreeHostPorts.baseClaimFreeHostPorts).to.equal(baseClaimFreeHostPorts)
    return loadDockerArgs(published)
}

async function assertExplicitPortRefused(initialFiles, explicitPort) {
    const memory = makeMemoryConfigService(initialFiles)
    const published = new Map([[explicitPort, new Set([FIRST_TRACKER])]])
    const dockerArgs = installProductionWrapper(memory, published)
    const installConfig = await memory.cs.getDefaultConfig(
        XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
    const portArgs = ['-p', `${installConfig.UTXO_TRACKER_PORT}:${installConfig.UTXO_TRACKER_API_PORT}`]

    let thrown = null
    try {
        await dockerArgs.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, {
            module: XChainService.XCHAIN_UTXO_TRACKER,
            environmentVariables: installConfig
        })
    } catch (err) {
        thrown = err
    }

    expect(thrown).to.be.an.instanceOf(Error)
    expect(thrown.message).to.include(`host port ${explicitPort} is already published by`)
    expect(portArgs).to.deep.equal(['-p', `${explicitPort}:3001`])
    return memory
}

describe('moved install host ports', function () {
    afterEach(function () {
        const hostPortClaim = require(hostPortClaimPath)
        if (baseClaimFreeHostPorts) hostPortClaim.claimFreeHostPorts = baseClaimFreeHostPorts
        delete require.cache[bootstrapGuardPath]
        delete require.cache[dockerArgsPath]
    })

    it('installs the production wrapper, persists a moved port, and reports it to the hub', async function () {
        const memory = makeMemoryConfigService({ [coinMain]: '' })
        const published = new Map([['3001', new Set([FIRST_TRACKER])]])
        const dockerArgs = installProductionWrapper(memory, published)
        const installConfig = await memory.cs.getDefaultConfig(
            XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
        const portArgs = ['-p', `${installConfig.UTXO_TRACKER_PORT}:${installConfig.UTXO_TRACKER_API_PORT}`]

        await dockerArgs.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, {
            module: XChainService.XCHAIN_UTXO_TRACKER,
            environmentVariables: installConfig
        })

        expect(portArgs).to.deep.equal(['-p', '3101:3001'])
        expect(memory.files[coinSidecar]).to.match(/(?:^|\n)UTXO_TRACKER_PORT=3101(?:\n|$)/)

        const reloaded = await memory.cs.getDefaultConfig('', 'bitcoin', 'mainnet')
        const reported = buildHubModuleConfig(
            XChainService.XCHAIN_UTXO_TRACKER, reloaded, {})
        expect(reported).to.include({ port: 3001, server_port: '3101' })
    })

    it('refuses a clashing port explicitly configured in the main file', async function () {
        await assertExplicitPortRefused({
            [coinMain]: 'UTXO_TRACKER_PORT=4101\n'
        }, '4101')
    })

    it('refuses a clashing port explicitly configured in the local sidecar', async function () {
        const memory = await assertExplicitPortRefused({
            [coinMain]: '',
            [coinSidecar]: 'UTXO_TRACKER_PORT=4101\n'
        }, '4101')
        expect(memory.files[coinSidecar]).to.match(/(?:^|\n)UTXO_TRACKER_PORT=4101(?:\n|$)/)
    })
})
