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
const {
    NODE_VERSION_ORDER,
    nodeVersionParts,
    remoteNodeVersion
} = require('../../../../src/ui/menu/node_version_order')

describe('ui/menu/node_version_order', function () {
    describe('nodeVersionParts()', function () {
        it('reads two-, three- and four-part daemon tags, with or without the v', function () {
            expect(nodeVersionParts('28.1\n')).to.deep.equal([28, 1])
            expect(nodeVersionParts('v1.14.9')).to.deep.equal([1, 14, 9])
            expect(nodeVersionParts('v0.21.5.6')).to.deep.equal([0, 21, 5, 6])
        })

        it('rejects the menu sentinel "0" and anything that is not a dotted version', function () {
            for (const raw of ['0', '', null, undefined, 'latest', 'v28', '28.1-rc1', '28..1']) {
                expect(nodeVersionParts(raw), String(raw)).to.equal(null)
            }
        })
    })

    describe('NODE_VERSION_ORDER', function () {
        it('orders by numeric parts, not by string or by semver', function () {
            expect(NODE_VERSION_ORDER.gt('v31.1', '28.1')).to.equal(true)
            expect(NODE_VERSION_ORDER.gt('v0.21.5.6', 'v0.21.5.5')).to.equal(true)
            expect(NODE_VERSION_ORDER.gt('v1.14.10', 'v1.14.9')).to.equal(true)
            expect(NODE_VERSION_ORDER.gt('28.1', 'v31.1')).to.equal(false)
        })

        it('treats a missing trailing part as zero and ignores the v', function () {
            expect(NODE_VERSION_ORDER.eq('v28.1', '28.1\n')).to.equal(true)
            expect(NODE_VERSION_ORDER.eq('28.1', '28.1.0')).to.equal(true)
        })
    })

    describe('remoteNodeVersion()', function () {
        it('reads the release tag, or "0" when no release was stored', function () {
            expect(remoteNodeVersion({ tag_name: 'v28.1', id: 7 })).to.equal('v28.1')
            expect(remoteNodeVersion(null)).to.equal('0')
            expect(remoteNodeVersion(undefined)).to.equal('0')
            expect(remoteNodeVersion({})).to.equal('0')
        })
    })
})
