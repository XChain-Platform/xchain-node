/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict'

let fs = require('fs')
let zlib = require('zlib')
let { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const { PassThrough } = require('stream')
let execFileAsync = promisify(execFile)
let { startProgress } = require('./workspace')

const STAGING_DIR = '/data/.restore-staging'
const VALIDATION_STAGING_DIR = STAGING_DIR.replace(/^\/data/, '/store')
const VALIDATE_SCRIPT = `
require('./src/bootstrap/staged_restore')
    .assertStagedLayoutOrThrow(process.argv[1])
    .catch(err => { process.stderr.write(err.message + '\\n'); process.exitCode = 1 })
`

function configureDependencies(dependencies) {
    fs = dependencies.fs
    zlib = dependencies.zlib
    ;({ execFile, spawn } = dependencies.childProcess)
    execFileAsync = promisify(execFile)
    ;({ startProgress } = dependencies.workspace)
}

async function prepareStaging(volumeName) {
    const script = `mkdir -p ${STAGING_DIR} && find ${STAGING_DIR} -mindepth 1 -delete`
    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', script
    ])
}

async function extractToStaging({ innerArchive, volumeName }) {
    const stats = await fs.promises.stat(innerArchive)
    return new Promise((resolve, reject) => {
        const progress = startProgress('Restoring LevelDB data...', stats.size)
        const readStream = fs.createReadStream(innerArchive)
        const counter = new PassThrough()
        const gunzip = zlib.createGunzip()
        const tarProc = spawn('docker', [
            'run', '--rm', '-i', '-v', `${volumeName}:/data`, 'alpine',
            'tar', 'xf', '-', '-C', STAGING_DIR
        ], { stdio: ['pipe', 'inherit', 'pipe'] })
        let settled = false
        const fail = err => { if (!settled) { settled = true; reject(err) } }

        counter.on('data', chunk => progress.update(chunk.length))
        tarProc.stderr.on('data', () => {})
        for (const source of [readStream, counter, gunzip, tarProc]) source.on('error', fail)
        readStream.pipe(counter).pipe(gunzip).pipe(tarProc.stdin)
        tarProc.on('close', (code, signal) => {
            if (settled) return
            if (code !== 0) {
                const suffix = signal ? ` (signal ${signal})` : ''
                fail(new Error(`docker tar restore exited with code ${code}${suffix}`))
                return
            }
            settled = true
            resolve(progress)
        })
    })
}

async function trackerImageId(containerId) {
    const { stdout } = await execFileAsync('docker', [
        'inspect', '--format', '{{.Image}}', containerId
    ], { timeout: 15000 })
    const imageId = String(stdout).trim()
    if (!imageId) throw new Error('the tracker container image could not be resolved')
    return imageId
}

async function validateStagedStore(containerId, volumeName) {
    const imageId = await trackerImageId(containerId)
    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/store`, '-w', '/XChainUtxoTracker',
        '--entrypoint', 'node', imageId, '-e', VALIDATE_SCRIPT,
        VALIDATION_STAGING_DIR
    ], { timeout: 300000 })
}

async function wipeLiveVolume(volumeName) {
    const script = `find /data -mindepth 1 -maxdepth 1 ! -name '.restore-staging' ` +
        `-exec sh -c 'find "$1" -depth -delete' _ {} ';'`
    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', script
    ])
}

async function promoteStagedVolume(volumeName) {
    const script = [
        `find ${STAGING_DIR}/.restore-staging -depth -delete 2>/dev/null || true`,
        `find ${STAGING_DIR} -mindepth 1 -maxdepth 1 -exec mv {} /data/ ';'`,
        `find ${STAGING_DIR} -depth -delete`
    ].join('\n')
    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', script
    ])
}

async function discardStaging(volumeName) {
    try {
        await execFileAsync('docker', [
            'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c',
            `find ${STAGING_DIR} -depth -delete`
        ])
    } catch { /* the validation error is primary */ }
}

async function restoreTrackerVolume({ containerId, innerArchive, volumeName, workDir }) {
    let postWipe = false
    try {
        await prepareStaging(volumeName)
        const progress = await extractToStaging({ innerArchive, volumeName })
        await validateStagedStore(containerId, volumeName)
        postWipe = true
        await wipeLiveVolume(volumeName)
        await promoteStagedVolume(volumeName)
        progress.stop('LevelDB data restored')
        fs.rmSync(workDir, { recursive: true })
    } catch (err) {
        if (postWipe) err.postWipe = true
        else await discardStaging(volumeName)
        throw err
    }
}

module.exports = { configureDependencies, restoreTrackerVolume }
