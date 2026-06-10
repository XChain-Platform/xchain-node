'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const { dockerMariadbArgs, mariadbEnv } = require('../../src/utils/dockerMariadb')

describe('utils/dockerMariadb', function () {

    describe('dockerMariadbArgs()', function () {

        it('builds a docker exec invocation forwarding MYSQL_PWD by name only', function () {
            const args = dockerMariadbArgs('container-id', ['mariadb', '-u', 'root', '-e', 'SELECT 1'])
            expect(args).to.deep.equal([
                'exec', '-e', 'MYSQL_PWD', 'container-id',
                'mariadb', '-u', 'root', '-e', 'SELECT 1'
            ])
        })

        it('inserts -i before the env forward when interactive', function () {
            const args = dockerMariadbArgs('container-id', ['mariadb-dump', '-u', 'root', 'db'], { interactive: true })
            expect(args.slice(0, 5)).to.deep.equal(['exec', '-i', '-e', 'MYSQL_PWD', 'container-id'])
        })

        it('never embeds a password value in argv', function () {
            const args = dockerMariadbArgs('container-id', ['mariadb', '-u', 'root'])
            expect(args.some(a => a.startsWith('-p'))).to.be.false
            expect(args.some(a => a.includes('='))).to.be.false
        })
    })

    describe('mariadbEnv()', function () {

        it('returns process.env plus MYSQL_PWD', function () {
            const env = mariadbEnv('s3cret')
            expect(env.MYSQL_PWD).to.equal('s3cret')
            expect(env.PATH).to.equal(process.env.PATH)
        })

        it('does not mutate process.env', function () {
            mariadbEnv('s3cret')
            expect(process.env.MYSQL_PWD).to.not.equal('s3cret')
        })
    })
})
