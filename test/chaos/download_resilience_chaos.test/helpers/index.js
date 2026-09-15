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
const proxyquire = require('proxyquire').noCallThru()

// Helpers
const validHash = 'a'.repeat(64)
const validHashesData = {
    'owner/repo': { 'v1.0.0': validHash }
}

function makeAxiosStub() {
    return {
        get: sinon.stub(),
        post: sinon.stub()
    }
}

function loadDownloader(opts = {}) {
    const fsStub = opts.fs || {
        existsSync: sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        createWriteStream: sinon.stub().returns({ on: sinon.stub() }),
        mkdirSync: sinon.stub(),
        rmSync: sinon.stub(),
        unlinkSync: sinon.stub(),
        readdirSync: sinon.stub().returns([]),
        statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
        readFileSync: sinon.stub().callsFake((p) => {
            if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                return JSON.stringify(opts.hashesData || validHashesData)
            }
            return Buffer.from('file-content')
        })
    }
    const axiosStub = opts.axios || makeAxiosStub()
    const spawnSyncStub = opts.spawnSync || sinon.stub().returns({ status: 0 })

    // The hash checks live in a part the class installs on its prototype, so
    // the part is loaded with the same fs stub and handed to the entry.
    const hashVerification = proxyquire('../../../../src/services/github_downloader/hash_verification.js', {
        'fs': fsStub
    })
    const GitHubDownloader = proxyquire('../../../../src/services/github_downloader', {
        'fs': fsStub,
        'axios': axiosStub,
        'child_process': { spawnSync: spawnSyncStub },
        './github_downloader/hash_verification.js': hashVerification
    })

    return { GitHubDownloader, fsStub, axiosStub, spawnSyncStub }
}

module.exports = { validHash, validHashesData, makeAxiosStub, loadDownloader }
