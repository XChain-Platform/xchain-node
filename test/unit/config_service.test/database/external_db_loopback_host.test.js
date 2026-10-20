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
const { isLoopbackHost } = require('../../../../src/services/config_service/validation')
const databaseModule = require('../../../../src/services/config_service/database')
const { buildHubModuleConfig } = require('../../../../src/services/hub_service/hub_module_config')
const { DB_MODULE_NAME } = require('../../../../src/config')

const LOOPBACK = ['127.0.0.1', '127.1.2.3', 'localhost', 'LocalHost.', 'db.localhost', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0', ' 127.0.0.1 ']
const REACHABLE = ['172.17.0.1', '172.18.0.1', '10.0.0.5', 'db.example.com', 'host.docker.internal', '128.0.0.1']

describe('external-DB loopback host guard', function () {
    it('names every loopback spelling and no reachable host', function () {
        for (const host of LOOPBACK) expect(isLoopbackHost(host), host).to.equal(true)
        for (const host of REACHABLE) expect(isLoopbackHost(host), host).to.equal(false)
    })

    it('refuses to write a loopback host into a service container env', function () {
        const config = { DECODER_DB_HOST: 'mariadb', DECODER_DB_PORT: 3306 }
        expect(() => databaseModule.applyExternalDatabase(config, { host: '127.0.0.1', port: 3306 }))
            .to.throw(/loopback address/)
        expect(config.DECODER_DB_HOST).to.equal('mariadb')
    })

    it('leaves a config with no database host keys untouched by a loopback host', function () {
        const config = { NODE_PORT: 8332 }
        databaseModule.applyExternalDatabase(config, { host: '127.0.0.1', port: 3306 })
        expect(config).to.deep.equal({ NODE_PORT: 8332 })
    })

    it('refuses a loopback host in the hub database descriptor', function () {
        const loopback = { EXTERNAL_DB: true, externalDbCfg: { host: 'localhost', port: 3306 } }
        expect(() => buildHubModuleConfig(DB_MODULE_NAME, {}, loopback)).to.throw(/loopback address/)
        const gateway = { EXTERNAL_DB: true, externalDbCfg: { host: '172.17.0.1', port: 3307 } }
        expect(buildHubModuleConfig(DB_MODULE_NAME, {}, gateway)).to.deep.equal({ host: '172.17.0.1', port: 3307 })
    })
})
