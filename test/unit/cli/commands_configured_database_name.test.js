'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins that the CLI command layer resolves the indexer database through
// configuredDatabaseName, so an operator-configured INDEXER_DB_NAME is honoured.

const sinon = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

const realConfigService = require('../../../src/services/config_service')

function load(moduleConfig) {
    const getDefaultConfig = sinon.stub().resolves(moduleConfig)
    const getModuleDatabaseName = sinon.stub().returns('derived_default_db')
    const commands = proxyquire('../../../src/cli/commands', {
        '../services/config_service': Object.assign({}, realConfigService, { getDefaultConfig, getModuleDatabaseName })
    })
    return { commands, getDefaultConfig, getModuleDatabaseName }
}

describe('cli commands configured database name', () => {
    it('uses the operator-configured INDEXER_DB_NAME', async () => {
        const { commands, getDefaultConfig } = load({ INDEXER_DB_NAME: 'custom_indexer_db' })
        expect(await commands.rehearsalSourceDatabaseName('bitcoin', 'mainnet')).to.equal('custom_indexer_db')
        expect(getDefaultConfig.calledOnce).to.equal(true)
    })

    it('falls back to the derived name when none is configured', async () => {
        const { commands } = load({ INDEXER_DB_NAME: '  ' })
        expect(await commands.rehearsalSourceDatabaseName('bitcoin', 'mainnet')).to.equal('derived_default_db')
    })

    it('rejects an unsafe configured name', async () => {
        const { commands } = load({ INDEXER_DB_NAME: 'bad name; drop' })
        let error = null
        try { await commands.rehearsalSourceDatabaseName('bitcoin', 'mainnet') } catch (err) { error = err }
        expect(error).to.be.an('error')
    })
})
