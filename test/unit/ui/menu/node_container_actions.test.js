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

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const { makeStubs } = require('../../module_service.test/support/helpers')

const CONTAINER_ID = 'c'.repeat(64)
const LABELS = ['Update Container', 'Install Local Version in Container', 'Reinstall']

function loadMenu(installModule) {
    return proxyquire('../../../../src/ui/menu.js', {
        '../services/version_service': {},
        '../operations/module_operations': {},
        '../services/module_service': { installModule, cloneGit: async () => {} },
        '../cli/dispatch': { scopedCommandLock: () => ({ hold() {}, release() {} }) }
    })
}

function loadService(localNodeVersion) {
    const stubs = makeStubs()
    const buildCryptoNode = sinon.stub().resolves(true)
    const getCryptoNode = sinon.stub().resolves()
    const ms = proxyquire('../../../../src/services/module_service', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => ({ bitcoin: { mainnet: { node: { container_version: 'v25.0.0' } } } })
        },
        './config_service': {
            getModuleDir: (mod) => '/modules/' + mod,
            checkIfModuleExists: sinon.stub().returns(true),
            getDockerContainerImageName: sinon.stub().returns('node'),
            getDockerNetwork: sinon.stub().returns('net'),
            validatePort: () => true,
            getDefaultConfig: sinon.stub().resolves({})
        },
        './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
        './docker_service': { stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
        './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
        './version_service': { getLocalNodeVersion: sinon.stub().resolves(localNodeVersion), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
        './node_service': { buildCryptoNode, getCryptoNode },
        './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
    })
    return { ms, buildCryptoNode, getCryptoNode }
}

describe('ui/menu node container actions rebuild the node', function () {
    for (const label of LABELS) {
        it(`"${label}" on the node hands the container id to installModule`, async function () {
            const install = sinon.stub().resolves(true)
            const menu = loadMenu(install)
            await menu.runInstalledModuleAction(label, { value: 'node', container_id: CONTAINER_ID }, 'bitcoin', 'mainnet')
            expect(install.calledOnceWithExactly('node', 'bitcoin', 'mainnet', false, CONTAINER_ID)).to.equal(true)
        })
    }

    it('installModule rebuilds an installed node when given a container id, without downloading', async function () {
        const { ms, buildCryptoNode, getCryptoNode } = loadService('v25.0.0')
        const result = await ms.installModule('node', 'bitcoin', 'mainnet', false, CONTAINER_ID)
        expect(result).to.equal(true)
        expect(buildCryptoNode.calledOnceWithExactly('bitcoin', 'mainnet')).to.equal(true)
        expect(getCryptoNode.called).to.equal(false)
    })

    it('installModule still skips an installed node with no rebuild request', async function () {
        const { ms, buildCryptoNode } = loadService('v25.0.0')
        expect(await ms.installModule('node', 'bitcoin', 'mainnet', false)).to.equal(false)
        expect(buildCryptoNode.called).to.equal(false)
    })
})
