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

const {
    sinon, expect, makeStubs, makeConfigServiceStub, loadModuleService,
    stubDockerCreate, runArgsOf, moduleSuite
} = require('./support/helpers')

function createFixture(configService = makeConfigServiceStub()) {
    const stubs = makeStubs()
    const seen = stubDockerCreate(stubs)
    const service = loadModuleService(stubs, null, { './config_service': configService })
    return {
        create: async () => {
            await service.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            return runArgsOf(seen)
        }
    }
}

const healthcheckedEncoder = createFixture()

moduleSuite('buildAndUp() init and wget timeout', function () {
    it('passes init and a bounded wget command for a healthchecked module', async function () {
        const args = await healthcheckedEncoder.create()
        expect(args).to.include('--init')
        const healthCommand = args[args.indexOf('--health-cmd') + 1]
        expect(healthCommand).to.match(/^wget -T 5\b/)
    })

    it('passes init when healthcheck argument construction returns no arguments', async function () {
        const configService = makeConfigServiceStub()
        const environmentVariables = await configService.getDefaultConfig()
        delete environmentVariables.ENCODER_API_PORT
        configService.getDefaultConfig = sinon.stub().resolves(environmentVariables)
        const args = await createFixture(configService).create()
        expect(args).to.include('--init')
        expect(args).to.not.include('--health-cmd')
    })
})
