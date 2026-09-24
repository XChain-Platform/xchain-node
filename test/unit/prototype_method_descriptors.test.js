'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')

const MariaDbStore = require('../../src/db')
const { modulesMixin } = require('../../src/db/modules')
const GitHubDownloader = require('../../src/services/github_downloader')
const hashVerification = require('../../src/services/github_downloader/hash_verification')

describe('prototype method descriptors', function () {
    const installations = [
        ['MariaDbStore', MariaDbStore.prototype, modulesMixin],
        ['GitHubDownloader', GitHubDownloader.prototype, hashVerification]
    ]

    for (const [className, prototype, methods] of installations) {
        for (const methodName of Reflect.ownKeys(methods)) {
            it(`${className}.${String(methodName)} is non-enumerable and callable`, function () {
                const sourceDescriptor = Object.getOwnPropertyDescriptor(methods, methodName)
                const installedDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName)

                expect(installedDescriptor).to.include({
                    configurable: sourceDescriptor.configurable,
                    enumerable: false,
                    writable: sourceDescriptor.writable
                })
                expect(installedDescriptor.value).to.equal(sourceDescriptor.value)
                expect(prototype[methodName]).to.be.a('function')
            })
        }
    }
})
