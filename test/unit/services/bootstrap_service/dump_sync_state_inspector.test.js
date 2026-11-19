'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const {
    createDumpSyncStateInspector
} = require('../../../../src/services/bootstrap_service/dump_sync_state_inspector')

const CREATE = [
    'CREATE TABLE `sync_state` (',
    '  `state_key` varchar(128) NOT NULL,',
    '  `state_value` text DEFAULT NULL,',
    '  `updated_at` datetime DEFAULT current_timestamp(),',
    '  PRIMARY KEY (`state_key`)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;'
].join('\n') + '\n'

async function inspect(input, oneByte = false) {
    const stream = createDumpSyncStateInspector()
    const finished = new Promise((resolve, reject) => {
        stream.on('finish', resolve)
        stream.on('error', reject)
    })
    const bytes = Buffer.from(input)
    if (oneByte) {
        for (const byte of bytes) stream.write(Buffer.from([byte]))
        stream.end()
    } else {
        stream.end(bytes)
    }
    await finished
    return stream.getVerdict()
}

describe('dump sync_state inspector', function () {
    it('accepts a dump without sync_state and clean optional values', async function () {
        expect(await inspect('CREATE TABLE `blocks` (`id` int);\n')).to.deep.equal({
            pendingHalt: 0, rollbackGuardInvalid: 0, unreadable: []
        })
        const rows = "INSERT INTO `sync_state` VALUES " +
            "('other','caf\\'é\\\\path\\nline','2026-11-19 00:00:00')," +
            "('halt_pending:decoder','',NULL)," +
            "('halt_pending:indexer',NULL,NULL)," +
            "('rollback_guard:decoder','{\\\"peak\\\":5,\\\"low\\\":3}',NULL)," +
            "('rollback_guard:indexer',NULL,NULL);\n"
        expect(await inspect(CREATE + rows)).to.deep.equal({
            pendingHalt: 0, rollbackGuardInvalid: 0, unreadable: []
        })
    })

    it('counts pending copies case-insensitively and invalid rollback guards', async function () {
        const rows = "INSERT INTO `sync_state` VALUES " +
            "('halt_pending:decoder','{\\\"reason\\\":\\\"halt\\\"}',NULL)," +
            "('HALT_PENDING:indexer','x',NULL);\n" +
            "INSERT INTO `sync_state` VALUES ('rollback_guard:decoder','not json',NULL);\n"
        expect(await inspect(CREATE + rows)).to.deep.equal({
            pendingHalt: 2, rollbackGuardInvalid: 1, unreadable: []
        })
    })

    it('produces the same verdict across one-byte chunks', async function () {
        const input = CREATE +
            "INSERT INTO `sync_state` VALUES ('halt_pending:decoder','x',NULL);\n"
        expect(await inspect(input, true)).to.deep.equal(await inspect(input))
    })

    it('fails closed on unknown escapes, reordered columns, and truncated inserts', async function () {
        const unknown = await inspect(CREATE +
            "INSERT INTO `sync_state` VALUES ('other','bad\\q',NULL);\n")
        expect(unknown.unreadable.join(' ')).to.match(/unknown escape/)

        const reordered = CREATE.replace(
            '  `state_key` varchar(128) NOT NULL,\n  `state_value` text DEFAULT NULL,',
            '  `state_value` text DEFAULT NULL,\n  `state_key` varchar(128) NOT NULL,')
        expect((await inspect(reordered)).unreadable.join(' ')).to.match(/columns are/)

        const truncated = await inspect(CREATE +
            "INSERT INTO `sync_state` VALUES ('halt_pending:decoder','x',NULL)")
        expect(truncated.unreadable.join(' ')).to.match(/tuple separator/)
    })

    it('fails closed when an INSERT has no matching CREATE TABLE', async function () {
        const verdict = await inspect(
            "INSERT INTO `sync_state` VALUES ('halt_pending:decoder','x',NULL);\n")
        expect(verdict.unreadable.join(' ')).to.match(/without a readable CREATE TABLE/)
    })
})
