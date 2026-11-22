/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

const REHEARSAL_DATABASE = 'xchain_restore_rehearsal'

function mariaTool(context, tool, args, interactive, deps) {
    if (context.external) {
        return {
            file: tool,
            args: ['-h', context.external.host, '-P', String(context.external.port),
                '-u', context.external.root_user].concat(args),
            env: deps.mariadbEnv(context.external.root_password)
        }
    }
    return {
        file: 'docker',
        args: deps.dockerMariadbArgs(context.containerId,
            [tool, '-u', 'root'].concat(args), { interactive }),
        env: deps.mariadbEnv(context.rootPassword)
    }
}

async function runMariaTool(context, tool, args, deps) {
    const command = mariaTool(context, tool, args, false, deps)
    return deps.execFileAsync(command.file, command.args, { env: command.env })
}

async function rehearsalContext(coin, network, deps) {
    if (deps.config.EXTERNAL_DB) return { external: await deps.database.getExternalDbConfig() }
    const containerId = await deps.database.getDatabaseContainerId()
    if (!containerId) throw new Error('MariaDB container not found')
    return { containerId, rootPassword: await deps.database.askMariadbRootPassword(coin, network) }
}

async function rehearsalArchive(coin, network, fileName, deps) {
    const module = deps.config.XChainService.XCHAIN_INDEXER
    const files = await deps.bootstrap.getBootstrapFilesList(coin, network, module)
    const selected = fileName || files[0]
    if (!selected) throw new Error(`No bootstrap archives found for ${coin}/${network} ${module}`)
    if (!files.includes(selected)) throw new Error(`Bootstrap '${selected}' not found`)
    const moduleConfig = await deps.getDefaultConfig(module, coin, network)
    const archivePath = deps.path.join(moduleConfig.INDEXER_BOOTSTRAP_VOLUME, selected)
    await deps.bootstrap.checkBootstrapSignature(archivePath)
    await deps.assertArchiveIdentity(archivePath, { module, coin, network })
    const workDir = deps.getWorkDir(coin, network, `${module}-rehearsal`)
    const innerArchive = await deps.bootstrap.ensureVerifiedInnerArchive(
        archivePath, workDir, 'dump.sql.gz', 'dump.sha256'
    )
    return { innerArchive, selected, workDir }
}

function showRowCount(stdout, table) {
    const rows = String(stdout).split('\n')
        .filter(line => line.startsWith('|'))
        .map(line => line.split('|').slice(1, -1).map(value => value.trim()))
    const rowColumn = rows[0] ? rows[0].indexOf('Rows') : -1
    const count = rowColumn >= 0 && rows[1] ? Number(rows[1][rowColumn]) : NaN
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Could not read ${table} count from mariadb-show`)
    }
    return count
}

async function databaseCounts(context, databaseName, deps) {
    const count = async table => {
        const result = await runMariaTool(context, 'mariadb-show', ['--count', databaseName, table], deps)
        return showRowCount(result.stdout, table)
    }
    return {
        rows: await count('blocks'),
        tokens: await count('tokens'),
        issuances: await count('issues')
    }
}

async function importRehearsal(context, innerArchive, deps) {
    const command = mariaTool(context, 'mariadb', [REHEARSAL_DATABASE], true, deps)
    const maria = deps.spawn(command.file, command.args,
        { stdio: ['pipe', 'inherit', 'inherit'], env: command.env })
    const closed = new Promise((resolve, reject) => {
        maria.once('error', reject)
        maria.once('close', code => code === 0
            ? resolve()
            : reject(new Error(`MariaDB rehearsal restore exited with code ${code}`)))
    })
    await Promise.all([
        deps.pipeline(deps.fs.createReadStream(innerArchive), deps.zlib.createGunzip(), maria.stdin),
        closed
    ])
}

function countsMatch(source, restored) {
    return source.rows === restored.rows && source.tokens === restored.tokens &&
        source.issuances === restored.issuances
}

async function rehearsalSourceDatabaseName(coin, network, deps) {
    const module = deps.config.XChainService.XCHAIN_INDEXER
    const moduleConfig = await deps.getDefaultConfig(module, coin, network)
    return deps.configuredDatabaseName(module, moduleConfig, deps.getModuleDatabaseName(module, coin, network))
}

async function rehearseBootstrapRestore(coin, network, options, deps) {
    if (network !== 'mainnet') throw new Error('Bootstrap restore rehearsal requires mainnet')
    const sourceName = await rehearsalSourceDatabaseName(coin, network, deps)
    const archive = await rehearsalArchive(coin, network, options.file, deps)
    const context = await rehearsalContext(coin, network, deps)
    let created = false
    try {
        const source = await databaseCounts(context, sourceName, deps)
        await runMariaTool(context, 'mariadb', ['-e', `DROP DATABASE IF EXISTS \`${REHEARSAL_DATABASE}\``], deps)
        deps.logger.info(`Cleared any leftover disposable database ${REHEARSAL_DATABASE}`)
        await runMariaTool(context, 'mariadb-admin', ['create', REHEARSAL_DATABASE], deps)
        created = true
        deps.logger.info(`Restoring ${archive.selected} into ${REHEARSAL_DATABASE}...`)
        await importRehearsal(context, archive.innerArchive, deps)
        const restored = await databaseCounts(context, REHEARSAL_DATABASE, deps)
        deps.logger.info(`source: rows=${source.rows} tokens=${source.tokens} issuances=${source.issuances}`)
        deps.logger.info(`${REHEARSAL_DATABASE}: rows=${restored.rows} tokens=${restored.tokens} issuances=${restored.issuances}`)
        return countsMatch(source, restored)
    } finally {
        deps.fs.rmSync(archive.workDir, { recursive: true, force: true })
        if (created) {
            await runMariaTool(context, 'mariadb-admin', ['--force', 'drop', REHEARSAL_DATABASE], deps)
            deps.logger.info(`Removed disposable database ${REHEARSAL_DATABASE}`)
        }
    }
}

function registerBootstrapRestoreRehearsal(program, commandDeps, deps) {
    program.command('bootstrap-restore-rehearsal')
        .description('Restore a mainnet indexer bootstrap into a disposable database and compare counts')
        .argument('<chain>', '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet)')
        .option('--file <name>', 'restore this exact local archive instead of the newest one')
        .action(async (chain, network, options) => {
            let exitCode = 1
            try {
                const matches = await rehearseBootstrapRestore(chain, network, options, deps)
                if (!matches) deps.logger.error('Bootstrap restore rehearsal count mismatch')
                exitCode = matches ? 0 : 1
            } catch (err) {
                deps.logger.error('Bootstrap restore rehearsal failed: ' +
                    commandDeps.redactSecrets(err && err.message ? err.message : err))
            }
            return process.exit(exitCode)
        })
}

module.exports = {
    showRowCount,
    countsMatch,
    rehearsalSourceDatabaseName,
    rehearseBootstrapRestore,
    registerBootstrapRestoreRehearsal
}
