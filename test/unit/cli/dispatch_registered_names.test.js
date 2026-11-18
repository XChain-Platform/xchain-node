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
//
// Every command name the dispatch lists carry must be a command the shipped
// CLI registers: a name that matches nothing reads as coverage it does not give.

const { expect } = require('chai')
const { Command } = require('commander')

const { dispatchSettings } = require('../../../src/cli/dispatch')
const { configureRootOptions, registerLifecycleCommands, registerStreamCommands } = require('../../../src/cli/options')
const { registerPrimaryCommands, registerToolCommands } = require('../../../src/cli/commands')
const { registerStatusCommands, registerValidatorCommands } = require('../../../src/cli/output')
const { registerPreRecoveryCommands, registerRecoveryCommands } = require('../../../src/cli/errors')

// Registration only reads deps lazily inside actions, so a deps object whose
// every member is a no-op builds the same tree the shipped parse step builds.
function registeredCommandNames() {
    const deps = new Proxy({ Command }, { get: (target, key) => (key in target ? target[key] : () => undefined) })
    const program = new Command()
    configureRootOptions(program, deps)
    for (const register of [
        registerPrimaryCommands, registerStatusCommands, registerLifecycleCommands, registerStreamCommands,
        registerToolCommands, registerPreRecoveryCommands, registerRecoveryCommands, registerValidatorCommands
    ]) register(program, deps)
    const names = new Set()
    for (const command of program.commands) {
        names.add(command.name())
        for (const alias of command.aliases()) names.add(alias)
    }
    return names
}

describe('dispatch command lists', function dispatchCommandLists() {
    const settings = dispatchSettings({})
    const registered = registeredCommandNames()

    it('registers the commands it expects to find', () => {
        expect([...registered]).to.include.members(['install', 'update', 'recreate', 'validator'])
    })

    for (const list of ['commandsNeedingVersions', 'readOnlyCommands', 'mutatingCommands']) {
        it(`${list} names only registered commands`, () => {
            const unregistered = settings[list].filter(name => !registered.has(name))
            expect(unregistered).to.deep.equal([])
        })
    }

    it('does not list a reinstall command, which the CLI does not register', () => {
        expect(registered.has('reinstall')).to.equal(false)
        for (const list of ['commandsNeedingVersions', 'readOnlyCommands', 'mutatingCommands']) {
            expect(settings[list], list).to.not.include('reinstall')
        }
    })
})
