/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'
// Dumps must stay inside the database they name and carry a schema.

const { expect, sinon, config, SERVICE, DATABASE, COMPLETE_DUMP, makeFile, expectRefusal, fakeChild, harness } = require('./helpers')

async function importStaysInsideTheNamedDatabase() {
    const h = harness()
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`)
    await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })
    const imports = h.spawns.filter(call => call.args.includes(DATABASE))
    expect(imports).to.have.length(1)
    const args = imports[0].args
    expect(args).to.include('--one-database')
    expect(args.indexOf('--one-database')).to.be.lessThan(args.indexOf(DATABASE))
    expect(h.spawns.filter(call => call !== imports[0])
        .every(call => !call.args.includes('--one-database'))).to.equal(true)
}

async function externalImportStaysInsideTheNamedDatabase() {
    const externalConfig = Object.create(config, { EXTERNAL_DB: { value: true } })
    const h = harness({
        config: externalConfig,
        getExternalDbConfig: sinon.stub().resolves({
            host: '10.0.0.5', port: 3307, root_user: 'root', root_password: 'ext-secret'
        }),
        mariadbEnv: password => ({ MYSQL_PWD: password })
    })
    const file = makeFile(h.directory, `${DATABASE}.external.sql.gz`)
    await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })
    const args = h.spawns.find(call => call.args.includes(DATABASE)).args
    expect(args.indexOf('--one-database')).to.be.greaterThan(-1)
    expect(args.indexOf('--one-database')).to.be.lessThan(args.indexOf(DATABASE))
}

const FOREIGN_BODIES = {
    'USE': 'USE XChain_BTC_Regtest_Decoder;\nCREATE TABLE canary (a INT);\nUSE ' + DATABASE + ';\n',
    'CREATE DATABASE': 'CREATE DATABASE other;\n',
    'DROP DATABASE': 'drop database if exists other;\n',
    'a schema-qualified name': 'CREATE TABLE `other_db`.`canary` (a INT);\n'
}

async function refusesADumpThatWritesOutsideItsDatabase() {
    for (const [label, body] of Object.entries(FOREIGN_BODIES)) {
        const h = harness()
        const contents = COMPLETE_DUMP.replace('-- Dump completed', body + '-- Dump completed')
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`, contents)
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /dump writes outside XChain_BTC_Testnet_Indexer/)
        expect(h.deps.stopModuleContainer.called, label).to.equal(false)
        expect(h.events, label).to.deep.equal([])
    }
}

async function acceptsOwnQualifiedNamesAndRowText() {
    const h = harness()
    const contents = 'CREATE TABLE `blocks` (block_index BIGINT);\n' +
        `CREATE VIEW v AS SELECT * FROM \`${DATABASE}\`.\`blocks\`;\n` +
        "INSERT INTO `blocks` VALUES ('USE other; `x`.`y`');\n" +
        '-- Dump completed on 2026-11-22 12:00:00\n'
    const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`, contents)
    const verification = await h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true })
    expect(verification.tableCount).to.equal(17)
}

// A gzip that passes the name and trailer checks but carries no schema. A
// restore of it would drop the live database and leave an empty one behind,
// so it must be refused before anything is stopped, dropped or imported.
const SCHEMA_LESS_BODIES = {
    'a bare trailer': '-- Dump completed\n',
    'comments and row data only': '-- MariaDB dump\nINSERT INTO `blocks` VALUES (1);\n' +
        "INSERT INTO `t` VALUES ('CREATE TABLE x (a INT)');\n-- CREATE TABLE y (a INT)\n-- Dump completed\n"
}

async function refusesASchemaLessDumpBeforeStoppingAnything() {
    const decoder = config.XChainService.XCHAIN_DECODER
    const decoderDatabase = 'XChain_DOGE_Regtest_Decoder'
    for (const [label, body] of Object.entries(SCHEMA_LESS_BODIES)) {
        const sql = []
        const spawn = sinon.stub().callsFake((file, args) => fakeChild(input => { sql.push({ args, input }) }))
        const h = harness({
            spawn,
            getDefaultConfig: sinon.stub().resolves({
                DECODER_DB_NAME: decoderDatabase,
                DECODER_DB_USER: 'xchain_decoder_dogecoin_regtest'
            }),
            getModuleDatabaseName: sinon.stub().returns(decoderDatabase)
        })
        const file = makeFile(h.directory, `${decoderDatabase}.stamp.sql.gz`, body)
        await expectRefusal(h.restoreDump(decoder, 'dogecoin', 'regtest', { file, yes: true }),
            /no CREATE TABLE/)
        expect(h.deps.stopModuleContainer.called, label).to.equal(false)
        expect(h.deps.startContainer.called, label).to.equal(false)
        expect(sql.some(call => /DROP|CREATE|GRANT/i.test(call.input)), label).to.equal(false)
        expect(sql.some(call => call.args.includes(decoderDatabase)), label).to.equal(false)
        expect(h.events, label).to.deep.equal([])
    }
}

describe('DumpRestoreService', function executionTests() {
    it('refuses a dump with no CREATE TABLE before stopping, dropping or importing anything', refusesASchemaLessDumpBeforeStoppingAnything)
    it('passes --one-database before the database name on the container import', importStaysInsideTheNamedDatabase)
    it('passes --one-database before the database name on the external import', externalImportStaysInsideTheNamedDatabase)
    it('refuses a dump with USE, CREATE or DROP DATABASE, or a foreign qualified name, before stopping anything', refusesADumpThatWritesOutsideItsDatabase)
    it('accepts the target database qualified names and row text that looks like SQL', acceptsOwnQualifiedNamesAndRowText)
})
