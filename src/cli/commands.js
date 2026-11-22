/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * XChain Node CLI command registration facade.
 ********************************************************************/
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const { pipeline } = require('stream/promises')
const config = require('../config')
const bootstrap = require('../services/bootstrap_service')
const { assertArchiveIdentity } = require('../services/bootstrap_service/restore_archive')
const { getWorkDir } = require('../services/bootstrap_service/workspace')
const database = require('../services/database_service')
const { getDefaultConfig, getModuleDatabaseName } = require('../services/config_service')
const { configuredDatabaseName } = require('../utils/module_database_name')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/docker_mariadb')
const { getLogger } = require('../observability/logger')
const { registerPrimaryCommands } = require('./commands/primary_commands')
const { registerToolCommands: registerToolCommandParts } = require('./commands/tool_commands')
const rehearsal = require('./commands/bootstrap_restore_rehearsal')

const rehearsalDependencies = {
    fs,
    path,
    zlib,
    spawn,
    pipeline,
    config,
    bootstrap,
    assertArchiveIdentity,
    getWorkDir,
    database,
    getDefaultConfig,
    getModuleDatabaseName,
    configuredDatabaseName,
    dockerMariadbArgs,
    mariadbEnv,
    execFileAsync: promisify(execFile),
    logger: getLogger()
}

function rehearsalSourceDatabaseName(coin, network) {
    return rehearsal.rehearsalSourceDatabaseName(coin, network, rehearsalDependencies)
}

function rehearseBootstrapRestore(coin, network, options) {
    return rehearsal.rehearseBootstrapRestore(coin, network, options, rehearsalDependencies)
}

function registerToolCommands(program, deps) {
    registerToolCommandParts(program, deps)
    rehearsal.registerBootstrapRestoreRehearsal(program, deps, rehearsalDependencies)
}

module.exports = {
    registerPrimaryCommands,
    registerToolCommands,
    showRowCount: rehearsal.showRowCount,
    countsMatch: rehearsal.countsMatch,
    rehearsalSourceDatabaseName,
    rehearseBootstrapRestore
}
