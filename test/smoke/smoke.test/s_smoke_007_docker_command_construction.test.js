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
const { proxyquireDockerService } = require('../../helpers/docker_service_loader')
const path       = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')

describe('S-SMOKE-007 – Docker Command Construction', function () {

    const DockerService = proxyquireDockerService(path.join(ROOT, 'src/services/docker_service'), {
        'child_process': {
            execFile: sinon.stub(),
            spawn: sinon.stub(),
            spawnSync: sinon.stub()
        },
        'util': { promisify: (fn) => fn },
        'fs': {
            readFileSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub().returns({ end: sinon.stub() })
        },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })

    it('exports all expected Docker operation functions', function () {
        const expectedFunctions = [
            'checkDockerInstalledAndReachable',
            'getStatusFromContainer',
            'createDockerNetwork',
            'addContainerToNetwork',
            'stopContainer',
            'startContainer',
            'restartContainer',
            'removeContainer',
            'killContainer',
            'execContainer',
            'shellContainer',
            'logContainer',
            'startDockerMonitor',
            'saveContainerLogs',
            'waitContainer'
        ]

        for (const fn of expectedFunctions) {
            expect(DockerService, `missing function: ${fn}`).to.have.property(fn).that.is.a('function')
        }
    })
})
