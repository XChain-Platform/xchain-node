'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function makeAxiosStub() {
    return { post: sinon.stub() }
}

function loadConnector(axiosStub) {
    return proxyquire('../../src/ExplorerConnector', {
        'axios': axiosStub
    })
}

describe('ExplorerConnector', function () {

    describe('constructor', function () {

        it('builds the URL as http://<url>:<port>', function () {
            const ExplorerConnector = loadConnector(makeAxiosStub())
            const connector = new ExplorerConnector('localhost', 18080)
            expect(connector.url).to.equal('http://localhost:18080')
        })

        it('stores the port on the instance', function () {
            const ExplorerConnector = loadConnector(makeAxiosStub())
            const connector = new ExplorerConnector('127.0.0.1', 8080)
            expect(connector.port).to.equal(8080)
        })
    })

    describe('ping()', function () {

        it('returns true when response contains a result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: 'pong' } })
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            const result = await connector.ping()
            expect(result).to.be.true
        })

        it('sends correct JSON-RPC payload', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: 'pong' } })
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            await connector.ping()

            const [url, data] = axiosStub.post.firstCall.args
            expect(url).to.equal('http://localhost:18080')
            expect(data.jsonrpc).to.equal('2.0')
            expect(data.method).to.equal('ping')
            expect(data.id).to.equal(1)
        })

        it('returns false when response has no result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: {} })
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            const result = await connector.ping()
            expect(result).to.be.false
        })

        it('returns false on network error', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(new Error('ECONNREFUSED'))
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            const result = await connector.ping()
            expect(result).to.be.false
        })
    })
})
