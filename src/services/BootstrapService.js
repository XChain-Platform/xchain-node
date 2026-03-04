/*********************************************************************
 * XChain Node - Bootstrap Service
 * Create and restore bootstrap files for XChain modules
 * Supported: xchain-utxo-tracker, xchain-decoder, xchain-indexer
 ********************************************************************/

const fs              = require('fs')
const path            = require('path')
const crypto          = require('crypto')
const zlib            = require('zlib')
const { spawn }       = require('child_process')
const { promisify }   = require('util')
const { PassThrough } = require('stream')
const execAsync       = promisify(require('child_process').exec)

const { XChainService, DB_MODULE_NAME, SEP, tmpDir } = require('../config/constants')
const { db }                                          = require('../state')
const { getDefaultConfig, getModuleDatabaseName }    = require('./ConfigService')
const { stopContainer, startContainer }               = require('./DockerService')

// ─── Private helpers ─────────────────────────────────────────────

function startProgress(message, totalBytes) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let written    = 0
    let frameIndex = 0

    const interval = setInterval(() => {
        const mb  = (written / 1024 / 1024).toFixed(1)
        const pct = totalBytes > 0
            ? Math.min(99, Math.floor(written / totalBytes * 100))
            : '?'
        process.stdout.write(`\r${frames[frameIndex++ % 10]} ${message} ${mb} MB (${pct}%)`)
    }, 100)

    return {
        update(bytes) { written += bytes },
        stop(finalMessage) {
            clearInterval(interval)
            process.stdout.write(`\r✓ ${finalMessage}\n`)
        }
    }
}

async function computeSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash   = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data',  chunk => hash.update(chunk))
        stream.on('end',   ()    => resolve(hash.digest('hex')))
        stream.on('error', err   => reject(err))
    })
}

function buildDateTimeString() {
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function getWorkDir(coin, network, module) {
    return path.join(tmpDir, `bootstrap-work-${coin}-${network}-${module}`)
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
    }
}

async function ensureDirWritable(dirPath) {
    const normalized = path.resolve(dirPath)

    if (!fs.existsSync(normalized)) {
        try {
            fs.mkdirSync(normalized, { recursive: true })
            return
        } catch { /* fall through to Docker approach */ }
    } else {
        try {
            fs.accessSync(normalized, fs.constants.W_OK)
            return
        } catch { /* fall through to Docker approach */ }
    }

    // Directory exists but isn't writable (likely created by Docker as root).
    // Use a throwaway Alpine container to create/chmod it.
    const parent  = path.dirname(normalized)
    const dirName = path.basename(normalized)
    await execAsync(`docker run --rm -v "${parent}:/parent" alpine sh -c "mkdir -p /parent/${dirName} && chmod 777 /parent/${dirName}"`)
}

// ─── Public: getBootstrapFilesList ───────────────────────────────

async function getBootstrapFilesList(coin, network, module) {
    const defaultConfig = await getDefaultConfig(module, coin, network)
    const fileList = []

    let directory = null
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            directory = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
            break
        case XChainService.XCHAIN_DECODER:
            directory = defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
            break
        case XChainService.XCHAIN_INDEXER:
            directory = defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
            break
        default:
            throw new Error(`Unsupported module for bootstrap: ${module}`)
    }

    try {
        const entries = await fs.promises.readdir(directory)
        for (const fileName of entries) {
            const filePath = path.join(directory, fileName)
            const stats    = await fs.promises.stat(filePath)
            if (stats.isFile()) fileList.push(fileName)
        }
        return fileList
    } catch (err) {
        throw err
    }
}

// ─── Public: makeBootstrap ────────────────────────────────────────

async function makeBootstrap(coin, network, module) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            return makeBootstrapUtxoTracker(coin, network)
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            return makeBootstrapMariaDb(coin, network, module)
        default:
            throw new Error(`Unsupported module for bootstrap create: ${module}`)
    }
}

async function makeBootstrapUtxoTracker(coin, network) {
    const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    const outputDir     = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
    const volumeName    = `${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${coin}-${network}-data`
    const archiveName   = `${network}${SEP}${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${buildDateTimeString()}.tar.gz`
    const workDir       = getWorkDir(coin, network, XChainService.XCHAIN_UTXO_TRACKER)
    const innerArchive  = path.join(workDir, 'data.tar.gz')
    const checksumFile  = path.join(workDir, 'data.sha256')
    const finalOutput   = path.join(outputDir, archiveName)

    // Step 1: Estimate volume size
    let totalBytes = 0
    try {
        const { stdout } = await execAsync(
            `docker run --rm -v "${volumeName}:/data" alpine sh -c "du -sb /data"`
        )
        totalBytes = parseInt(stdout.trim().split(/\s+/)[0], 10) || 0
    } catch {
        console.log('Could not estimate volume size, progress will show as ?%')
    }

    // Step 2: Get container ID and stop service
    const containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!containerId) throw new Error(`utxo-tracker container not found for ${coin}/${network}`)

    console.log(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(containerId)

    try {
        // Prepare directories
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
        ensureDir(workDir)
        await ensureDirWritable(outputDir)

        // Step 3: Stream LevelDB volume through gzip → data.tar.gz
        const progress = startProgress('Compressing LevelDB data...', totalBytes)
        await new Promise((resolve, reject) => {
            const tarProc     = spawn('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'tar', 'cf', '-', '-C', '/data', '.'])
            const counter     = new PassThrough()
            const gzipStream  = zlib.createGzip()
            const writeStream = fs.createWriteStream(innerArchive)

            counter.on('data', chunk => progress.update(chunk.length))

            tarProc.stdout.pipe(counter).pipe(gzipStream).pipe(writeStream)

            tarProc.stderr.on('data', () => {})
            tarProc.on('error', err => reject(err))
            writeStream.on('error', err => reject(err))
            writeStream.on('finish', resolve)
            tarProc.on('close', code => {
                if (code !== 0) reject(new Error(`docker tar exited with code ${code}`))
            })
        })
        const innerStats = await fs.promises.stat(innerArchive)
        progress.stop(`LevelDB compressed — ${(innerStats.size / 1024 / 1024).toFixed(1)} MB`)

        // Step 4: Compute SHA256 and write checksum file
        process.stdout.write('Computing checksum... ')
        const checksum = await computeSha256(innerArchive)
        await fs.promises.writeFile(checksumFile, `${checksum}  data.tar.gz\n`)
        console.log(checksum)

        // Step 5: Create outer wrapper archive
        console.log(`Wrapping into ${archiveName}...`)
        await execAsync(`tar czf "${finalOutput}" -C "${workDir}" data.tar.gz data.sha256`)

        // Cleanup work dir
        fs.rmSync(workDir, { recursive: true })
        console.log(`Bootstrap created: ${finalOutput}`)

    } finally {
        // Step 6: Always restart the container
        console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
        await startContainer(containerId)
    }

    return true
}

async function makeBootstrapMariaDb(coin, network, module) {
    const { askMariadbRootPassword } = require('./DatabaseService')

    const defaultConfig = await getDefaultConfig(module, coin, network)
    const outputDir     = module === XChainService.XCHAIN_DECODER
        ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
        : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
    const dbName        = getModuleDatabaseName(module, coin, network)
    const archiveName   = `${network}${SEP}${module}${SEP}${buildDateTimeString()}.tar.gz`
    const workDir       = getWorkDir(coin, network, module)
    const innerArchive  = path.join(workDir, 'dump.sql.gz')
    const checksumFile  = path.join(workDir, 'dump.sha256')
    const finalOutput   = path.join(outputDir, archiveName)

    // Step 1: Get DB container ID and credentials
    const dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
    if (!dbContainerId) throw new Error('MariaDB container not found')

    const rootPassword = await askMariadbRootPassword(coin, network)

    // Step 2: Estimate DB size
    let totalBytes = 0
    try {
        const sizeQuery = `SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}'`
        const { stdout } = await execAsync(
            `docker exec ${dbContainerId} mariadb -u root -p${rootPassword} -BN -e "${sizeQuery}" information_schema`
        )
        totalBytes = parseInt(stdout.trim(), 10) || 0
    } catch {
        console.log('Could not estimate DB size, progress will show as ?%')
    }

    // Prepare directories
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    await ensureDirWritable(outputDir)

    // Step 3: Stream mysqldump → gzip → dump.sql.gz
    const progress = startProgress(`Dumping ${dbName}...`, totalBytes)
    await new Promise((resolve, reject) => {
        const dumpProc    = spawn('docker', ['exec', '-i', dbContainerId, 'mariadb-dump', '-u', 'root', `-p${rootPassword}`, '--single-transaction', '--routines', '--triggers', dbName])
        const counter     = new PassThrough()
        const gzipStream  = zlib.createGzip()
        const writeStream = fs.createWriteStream(innerArchive)

        counter.on('data', chunk => progress.update(chunk.length))

        dumpProc.stdout.pipe(counter).pipe(gzipStream).pipe(writeStream)

        dumpProc.stderr.on('data', () => {})
        dumpProc.on('error', err => reject(err))
        writeStream.on('error', err => reject(err))
        writeStream.on('finish', resolve)
        dumpProc.on('close', code => {
            if (code !== 0) reject(new Error(`mariadb-dump exited with code ${code}`))
        })
    })
    const innerStats = await fs.promises.stat(innerArchive)
    progress.stop(`${dbName} dumped — ${(innerStats.size / 1024 / 1024).toFixed(1)} MB compressed`)

    // Step 4: Compute SHA256 and write checksum file
    process.stdout.write('Computing checksum... ')
    const checksum = await computeSha256(innerArchive)
    await fs.promises.writeFile(checksumFile, `${checksum}  dump.sql.gz\n`)
    console.log(checksum)

    // Step 5: Create outer wrapper archive
    console.log(`Wrapping into ${archiveName}...`)
    await execAsync(`tar czf "${finalOutput}" -C "${workDir}" dump.sql.gz dump.sha256`)

    // Cleanup work dir
    fs.rmSync(workDir, { recursive: true })
    console.log(`Bootstrap created: ${finalOutput}`)

    return true
}

// ─── Public: restoreBootstrap ─────────────────────────────────────

async function restoreBootstrap(coin, network, module, fileName) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            return restoreBootstrapUtxoTracker(coin, network, fileName)
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            return restoreBootstrapMariaDb(coin, network, module, fileName)
        default:
            throw new Error(`Unsupported module for bootstrap restore: ${module}`)
    }
}

async function restoreBootstrapUtxoTracker(coin, network, fileName) {
    const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    const bootstrapDir  = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
    const archivePath   = path.join(bootstrapDir, fileName)
    const volumeName    = `${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${coin}-${network}-data`
    const workDir       = getWorkDir(coin, network, `${XChainService.XCHAIN_UTXO_TRACKER}-restore`)

    if (!fs.existsSync(archivePath)) throw new Error(`Bootstrap file not found: ${archivePath}`)

    // Step 1: Extract outer archive
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    console.log('Extracting outer archive...')
    await execAsync(`tar xzf "${archivePath}" -C "${workDir}"`)

    const innerArchive = path.join(workDir, 'data.tar.gz')
    const checksumFile = path.join(workDir, 'data.sha256')

    if (!fs.existsSync(innerArchive) || !fs.existsSync(checksumFile)) {
        fs.rmSync(workDir, { recursive: true })
        throw new Error('Archive is malformed: missing data.tar.gz or data.sha256')
    }

    // Step 2: Verify checksum
    process.stdout.write('Verifying checksum... ')
    const stored   = (await fs.promises.readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0]
    const computed = await computeSha256(innerArchive)
    if (stored !== computed) {
        fs.rmSync(workDir, { recursive: true })
        throw new Error(`Checksum mismatch!\n  Expected: ${stored}\n  Got:      ${computed}`)
    }
    console.log('OK')

    // Step 3: Get container ID and stop service
    const containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!containerId) throw new Error(`utxo-tracker container not found for ${coin}/${network}`)

    console.log(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(containerId)

    try {
        // Step 4: Clear volume
        console.log('Clearing LevelDB volume...')
        await execAsync(`docker run --rm -v "${volumeName}:/data" alpine sh -c "find /data -mindepth 1 -delete"`)

        // Step 5: Restore data.tar.gz into volume with progress
        const stats      = await fs.promises.stat(innerArchive)
        const totalBytes = stats.size
        const progress   = startProgress('Restoring LevelDB data...', totalBytes)

        await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(innerArchive)
            const counter    = new PassThrough()
            const gunzip     = zlib.createGunzip()
            const tarProc    = spawn('docker', ['run', '--rm', '-i', '-v', `${volumeName}:/data`, 'alpine', 'tar', 'xf', '-', '-C', '/data'], { stdio: ['pipe', 'inherit', 'pipe'] })

            counter.on('data', chunk => progress.update(chunk.length))
            readStream.pipe(counter).pipe(gunzip).pipe(tarProc.stdin)

            readStream.on('error', err => reject(err))
            gunzip.on('error',    err => reject(err))
            tarProc.on('error',   err => reject(err))
            tarProc.on('close', code => {
                if (code === 0) resolve()
                else reject(new Error(`docker tar restore exited with code ${code}`))
            })
        })
        progress.stop('LevelDB data restored')

        // Cleanup
        fs.rmSync(workDir, { recursive: true })
        console.log('Bootstrap restore complete')

    } finally {
        // Step 6: Always restart container
        console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
        await startContainer(containerId)
    }

    return true
}

async function restoreBootstrapMariaDb(coin, network, module, fileName) {
    const { askMariadbRootPassword } = require('./DatabaseService')

    const defaultConfig = await getDefaultConfig(module, coin, network)
    const bootstrapDir  = module === XChainService.XCHAIN_DECODER
        ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
        : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
    const archivePath   = path.join(bootstrapDir, fileName)
    const dbName        = getModuleDatabaseName(module, coin, network)
    const workDir       = getWorkDir(coin, network, `${module}-restore`)

    if (!fs.existsSync(archivePath)) throw new Error(`Bootstrap file not found: ${archivePath}`)

    // Step 1: Extract outer archive
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    console.log('Extracting outer archive...')
    await execAsync(`tar xzf "${archivePath}" -C "${workDir}"`)

    const innerArchive = path.join(workDir, 'dump.sql.gz')
    const checksumFile = path.join(workDir, 'dump.sha256')

    if (!fs.existsSync(innerArchive) || !fs.existsSync(checksumFile)) {
        fs.rmSync(workDir, { recursive: true })
        throw new Error('Archive is malformed: missing dump.sql.gz or dump.sha256')
    }

    // Step 2: Verify checksum
    process.stdout.write('Verifying checksum... ')
    const stored   = (await fs.promises.readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0]
    const computed = await computeSha256(innerArchive)
    if (stored !== computed) {
        fs.rmSync(workDir, { recursive: true })
        throw new Error(`Checksum mismatch!\n  Expected: ${stored}\n  Got:      ${computed}`)
    }
    console.log('OK')

    // Step 3: Get DB container ID and credentials
    const dbContainerId = await db.getModuleContainer(DB_MODULE_NAME, "", "")
    if (!dbContainerId) throw new Error('MariaDB container not found')

    const rootPassword = await askMariadbRootPassword(coin, network)

    // Step 4: Drop and recreate database
    console.log(`Recreating database ${dbName}...`)
    await execAsync(
        `docker exec ${dbContainerId} mariadb -u root -p${rootPassword} -e "DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE ${dbName}"`
    )

    // Step 5: Pipe decompressed SQL into mariadb with progress
    const stats      = await fs.promises.stat(innerArchive)
    const totalBytes = stats.size
    const progress   = startProgress(`Restoring ${dbName}...`, totalBytes)

    await new Promise((resolve, reject) => {
        const readStream  = fs.createReadStream(innerArchive)
        const counter     = new PassThrough()
        const gunzip      = zlib.createGunzip()
        const mysqlProc   = spawn('docker', ['exec', '-i', dbContainerId, 'mariadb', '-u', 'root', `-p${rootPassword}`, dbName], { stdio: ['pipe', 'inherit', 'pipe'] })

        counter.on('data', chunk => progress.update(chunk.length))
        readStream.pipe(counter).pipe(gunzip).pipe(mysqlProc.stdin)

        readStream.on('error',  err => reject(err))
        gunzip.on('error',      err => reject(err))
        mysqlProc.on('error',   err => reject(err))
        mysqlProc.on('close', code => {
            if (code === 0) resolve()
            else reject(new Error(`mariadb restore exited with code ${code}`))
        })
    })
    progress.stop(`${dbName} restored`)

    // Cleanup
    fs.rmSync(workDir, { recursive: true })
    console.log('Bootstrap restore complete')

    return true
}

// ─── Exports ──────────────────────────────────────────────────────

module.exports = {
    getBootstrapFilesList,
    makeBootstrap,
    restoreBootstrap
}
