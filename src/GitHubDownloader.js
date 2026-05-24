/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Node - Github Downloader Class
 * 
 * This file handles downloading and managing files from github repos
 * 
 ********************************************************************/

// Load required libraries
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { spawnSync } = require('child_process');
const util = require('util');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);

// Map Node's process.arch to the substring used in GitHub release asset names
// for crypto-node tarballs (bitcoin-core / litecoin / dogecoin). Mirrors
// NodeService.js's archMap for bitcoincore.org downloads.
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64' };
const SHA256_RE = /^[a-f0-9]{64}$/i;

function getHostArch() {
    const arch = ARCH_MAP[process.arch];
    if (!arch) throw new Error(`Unsupported host architecture for GitHub asset download: ${process.arch}`);
    return arch;
}

class GitHubDownloader {
  constructor(hashesFilePath = './github_hashes.json') {
    this.hashesFilePath = path.resolve(hashesFilePath);
    this.hashesData = this.loadHashesFile();
  }

  loadHashesFile() {
    try {
      if (!fs.existsSync(this.hashesFilePath)) {
        fs.writeFileSync(this.hashesFilePath, JSON.stringify({}, null, 2));
        return {};
      }
      const data = JSON.parse(fs.readFileSync(this.hashesFilePath, 'utf8'));
      
      // Validates structure. A version entry is either:
      //   - a string  (legacy single-arch hash; treated as x86_64), or
      //   - an object { x86_64: sha, aarch64: sha, ... } for per-arch hashes.
      for (const [repo, versions] of Object.entries(data)) {
        if (typeof versions !== 'object') {
          throw new Error(`Invalid hash format for ${repo}`);
        }
        for (const [version, hash] of Object.entries(versions)) {
          if (typeof hash === 'string') {
            if (!SHA256_RE.test(hash)) {
              throw new Error(`Invalid SHA-256 hash for ${repo}@${version}`);
            }
          } else if (hash && typeof hash === 'object') {
            for (const [arch, archHash] of Object.entries(hash)) {
              if (typeof archHash !== 'string' || !SHA256_RE.test(archHash)) {
                throw new Error(`Invalid SHA-256 hash for ${repo}@${version}#${arch}`);
              }
            }
          } else {
            throw new Error(`Invalid hash entry for ${repo}@${version}`);
          }
        }
      }
      
      return data;
    } catch (error) {
      throw new Error(`Error loading hashes file: ${error.message}`);
    }
  }

  /**
   * Gets all releases from a repository using github api
   */
  async getReleases(owner, repoName) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repoName}/releases`,
        { headers: { 'User-Agent': 'GitHubDownloader' } }
      );
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`Can't find ${owner}/${repoName} repository using github api`);
      }
      throw new Error(`GitHub API Error: ${error.message}`);
    }
  }

  /**
   * Gets the most recent version of a repository in GitHub. If verifyHash is true, then it will return the
   * most recent version with an existing entry in the hashes file, in case verifyHash is false, 
   * it will return the most recent
   */
  async getLatestCompatibleVersion(owner, repoName, verifyHash = true) {
    const releases = await this.getReleases(owner, repoName);
    const repoKey = `${owner}/${repoName}`;

    // Reorders releases by date (most recent first)
    releases.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    if (verifyHash) {
      // Gets the most recent version with an entry in the hashes file
      for (const release of releases) {
        if (this.hasHash(repoKey, release.tag_name)) {
          return release;
        }
      }
      throw new Error(`Couldn't find a version of ${repoKey} with an entry in the hashes file`);
    }

    // If verifyHash is false, then just return the first one (most recent)
    return releases[0];
  }

  /**
   * Downloads a specific version of a repository from GitHub
   */
  async downloadRepoVersion(owner, repoName, version, options = {}) {
    const {
      outputPath = './downloads',
      verifyHash = true,
	  version_file_name = "__VERSION__.txt"
    } = options;

    const repoKey = `${owner}/${repoName}`;
    const fullOutputPath = path.join(outputPath, `${repoName}`);

    // Gets the specific release info
    const release = await this.getReleaseByTag(owner, repoName, version);
    
    if (verifyHash && !this.hasHash(repoKey, version)) {
      throw new Error( `Required SHA-256 hash not found for ${repoKey}@${version}`);
    }

    try {
      // Downloads the asset for linux
      await this.downloadReleaseAsset(release, fullOutputPath, repoKey, version, verifyHash);

	  if (fs.existsSync(fullOutputPath)) {
	    fs.writeFileSync(fullOutputPath + "/" + version_file_name, version)
	  }
	  
      return fullOutputPath;
    } catch (error) {
      if (fs.existsSync(fullOutputPath)) {
        fs.rmSync(fullOutputPath, { recursive: true });
      }
      throw error;
    }
  }

  /**
   * Gets a specific tag release
   */
  async getReleaseByTag(owner, repoName, tag) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repoName}/releases/tags/${tag}`,
        { headers: { 'User-Agent': 'GitHubDownloader' } }
      );
      return response.data;
    } catch (error) {
      throw new Error(`Error getting the release ${tag}: ${error.message}`);
    }
  }

  /**
   * Downloads the asset for a linux server matching the host architecture.
   * Picks the release asset whose name contains the host arch ("x86_64" /
   * "aarch64") and "linux" — i.e. one of the prebuilt linux-gnu tarballs.
   */
  async downloadReleaseAsset(release, outputPath, repoKey, version, verifyHash) {
    const arch = getHostArch();
    const asset = release.assets.find(a => {
      const name = a.name.toLowerCase();
      return name.includes(arch) && name.includes('linux');
    });

    if (!asset) {
      throw new Error(`Couldn't find an asset compatible with (linux, ${arch}) in the release ${release.tag_name}`);
    }

    try {
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      const response = await axios({
        method: 'get',
        url: asset.browser_download_url,
        responseType: 'stream',
        headers: {
          'Accept': 'application/octet-stream',
          'User-Agent': 'GitHubDownloader'
        }
      });

      const fileExtension = asset.name.split('.').pop();
      const downloadPath = path.join(outputPath, asset.name);

      await pipeline(response.data, fs.createWriteStream(downloadPath));

      // Verifies the download has the same hash as the entry in the hashes file
      if (verifyHash) {
        await this.verifyRepositoryHash(repoKey, version, downloadPath);
      }

      

      // Extracts files by extension
      if (fileExtension === 'gz' || fileExtension === 'tgz') {
        const result = spawnSync('tar', ['-xzf', downloadPath, '-C', outputPath], { stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`tar exited with code ${result.status}`);
        fs.unlinkSync(downloadPath);
      } else if (fileExtension === 'zip') {
        const result = spawnSync('unzip', [downloadPath, '-d', outputPath], { stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`unzip exited with code ${result.status}`);
        fs.unlinkSync(downloadPath);
      } else {
        console.warn(`Unrecognized file extension: ${fileExtension}. Will not extract.`);
      }

      // Handles directories structure after extracting the files
      const extractedDirs = fs.readdirSync(outputPath).filter(f => 
        fs.statSync(path.join(outputPath, f)).isDirectory()
      );

      if (extractedDirs.length === 1) {
        const tempPath = path.join(outputPath, extractedDirs[0]);
        fs.readdirSync(tempPath).forEach(file => {
          fs.renameSync(
            path.join(tempPath, file),
            path.join(outputPath, file)
          );
        });
        fs.rmdirSync(tempPath);
      }
    } catch (error) {
      throw new Error(`Error downloading asset: ${error.message}`);
    }
  }

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
  }

  /**
   * Resolve the hash for a (repo, version, arch) tuple. Legacy string-valued
   * entries return their string regardless of arch.
   */
  _getHashForArch(repoKey, version, arch) {
    const entry = this.hashesData[repoKey]?.[version];
    if (!entry) return null;
    if (typeof entry === 'string') return entry;
    return entry[arch] ?? null;
  }

  /**
   * Verifies repository hash against stored value. `arch` defaults to the
   * host arch; passing it explicitly is useful for cross-arch tooling.
   */
  async verifyRepositoryHash(repoKey, version, repoPath, arch = null) {
    const resolvedArch = arch ?? getHostArch();
    const expectedHash = this._getHashForArch(repoKey, version, resolvedArch);
    if (!expectedHash) {
      throw new Error(`No SHA-256 hash registered for ${repoKey}@${version} on ${resolvedArch}`);
    }
    const actualHash = await this.calculateDirectoryHash(repoPath);

    if (actualHash !== expectedHash) {
      throw new Error(`Hash verification failed for ${repoKey}@${version} (${resolvedArch})\nExpected: ${expectedHash}\nActual: ${actualHash}`);
    }

    console.log(`✅ Hash verified for ${repoKey}@${version} (${resolvedArch})`);
  }

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
  }

  /**
   * Recursively gets all files in directory
   */
  getAllFiles(dirPath) {
  try {
    // Verify if dirPath is a file or a directory
    const stats = fs.statSync(dirPath);
    if (stats.isFile()) {
      return [dirPath]; // Return the array with only that file
    }
    
    // If it's a directory then scans all files and returns them in an array
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        files.push(...this.getAllFiles(fullPath)); // Llamada recursiva
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
      // Ignora sockets, enlaces simbólicos, etc.
    }

    return files;
  } catch (error) {
    console.error(`Error procesando ${dirPath}:`, error);
    return []; // Devuelve array vacío en caso de error
  }
}
}

module.exports = GitHubDownloader;