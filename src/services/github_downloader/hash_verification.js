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
 **********************************************************************
 *
 * XChain Node - Github Downloader hash verification
 *
 * This file holds the hash lookup and the file and directory hash checks
 *
 ********************************************************************/

// Load required libraries
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { getLogger } = require('../../observability/logger');
const { getHostArch } = require('./host_arch.js');
const logger = getLogger();

// Installed on GitHubDownloader.prototype by the class file.
module.exports = {
  /**
   * Checks if hash exists for a version. If arch is given, requires a
   * matching arch-specific hash; otherwise any hash entry counts.
   */
  hasHash(repoKey, version, arch = null) {
    const entry = this.hashesData[repoKey]?.[version];
    if (!entry) return false;
    if (typeof entry === 'string') return true;
    if (arch === null) return Object.keys(entry).length > 0;
    return !!entry[arch];
  },

  /**
   * Resolve the hash for a (repo, version, arch) tuple. Legacy string-valued
   * entries return their string regardless of arch.
   */
  getHashForArch(repoKey, version, arch) {
    const entry = this.hashesData[repoKey]?.[version];
    if (!entry) return null;
    if (typeof entry === 'string') return entry;
    return entry[arch] ?? null;
  },

  /**
   * Verifies repository hash against stored value. `arch` defaults to the
   * host arch; passing it explicitly is useful for cross-arch tooling.
   */
  async verifyRepositoryHash(repoKey, version, repoPath, arch = null) {
    const resolvedArch = arch ?? getHostArch();
    const expectedHash = this.getHashForArch(repoKey, version, resolvedArch);
    if (!expectedHash) {
      throw new Error(`No SHA-256 hash registered for ${repoKey}@${version} on ${resolvedArch}`);
    }
    const actualHash = await this.calculateDirectoryHash(repoPath);

    if (actualHash !== expectedHash) {
      throw new Error(`Hash verification failed for ${repoKey}@${version} (${resolvedArch})\nExpected: ${expectedHash}\nActual: ${actualHash}`);
    }

    logger.info(`✅ Hash verified for ${repoKey}@${version} (${resolvedArch})`);
  },

  /**
   * Verifies a downloaded FILE (e.g. a prebuilt release tarball) against the
   * registered SHA-256, before it is decompressed or executed. This is the
   * counterpart to verifyRepositoryHash (which hashes an extracted source
   * directory) for binaries fetched as a single archive, notably the
   * Bitcoin Core tarball from bitcoincore.org, whose registered hashes are
   * the project's own published+GPG-signed SHA256SUMS values. Fails closed:
   * throws when no hash is registered for the (repo, version, arch) tuple.
   *
   * @param {string} filePath  the downloaded archive on disk
   * @param {string} repoKey   e.g. 'bitcoin/bitcoin'
   * @param {string} version   e.g. 'v28.1'
   * @param {string|null} arch defaults to the host arch
   */
  async verifyFileHash(filePath, repoKey, version, arch = null) {
    const resolvedArch = arch ?? getHostArch();
    const expectedHash = this.getHashForArch(repoKey, version, resolvedArch);
    if (!expectedHash) {
      throw new Error(`No SHA-256 hash registered for ${repoKey}@${version} on ${resolvedArch}`);
    }
    const actualHash = await this.calculateFileHash(filePath);

    if (actualHash !== expectedHash) {
      throw new Error(`Hash verification failed for ${repoKey}@${version} (${resolvedArch})\nExpected: ${expectedHash}\nActual: ${actualHash}`);
    }

    logger.info(`✅ Tarball hash verified for ${repoKey}@${version} (${resolvedArch})`);
  },

  /**
   * Calculates the SHA-256 hash of a single file's bytes.
   */
  async calculateFileHash(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  },

  /**
   * Calculates SHA-256 hash for directory contents
   */
  async calculateDirectoryHash(dirPath) {
    const hash = crypto.createHash('sha256');
    const files = this.getAllFiles(dirPath).sort();

    for (const file of files) {
      const fileBuffer = fs.readFileSync(file);
      hash.update(fileBuffer);
    }

    return hash.digest('hex');
  },

  // Recursively lists all files under dirPath (or [dirPath] itself when it is
  // already a file). Non-file/non-directory entries (sockets, symlinks, etc.)
  // are silently skipped.
  getAllFiles(dirPath) {
  try {
    // Verify if dirPath is a file or a directory
    const stats = fs.statSync(dirPath);
    if (stats.isFile()) {
      return [dirPath];
    }

    // If it's a directory then scans all files and returns them in an array
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...this.getAllFiles(fullPath));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
      // Ignora sockets, enlaces simbólicos, etc.
    }

    return files;
  } catch (error) {
    logger.error(util.format(`Error procesando ${dirPath}:`, error));
    return [];
  }
}
};
