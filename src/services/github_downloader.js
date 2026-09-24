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
 * XChain Node - Github Downloader Class
 * 
 * This file handles downloading and managing files from github repos
 * 
 ********************************************************************/

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
 *
 * XChain Node - Github Downloader Class
 * 
 * This file handles downloading and managing files from github repos
 * 
 ********************************************************************/

// Load required libraries
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawnSync } = require('child_process');
const { assertSafeArchiveMemberNames } = require('../utils/helpers');
const util = require('util');
const stream = require('stream');
const config = require('../config');
const { githubApiHeaders, githubRateLimitError } = require('../utils/github_api');
const { getLogger } = require('../observability/logger');
const logger = getLogger();
const pipeline = util.promisify(stream.pipeline);
const { getHostArch } = require('./github_downloader/host_arch.js');

const SHA256_RE = /^[a-f0-9]{64}$/i;

function installMethods(target, methods) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);
  for (const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
  Object.defineProperties(target, descriptors);
}

// Picks the release asset built for linux on the host architecture, or
// throws when the release has none.
function selectHostLinuxAsset(release) {
  const arch = getHostArch();
  const asset = release.assets.find(a => {
    const name = a.name.toLowerCase();
    return name.includes(arch) && name.includes('linux');
  });

  if (!asset) {
    throw new Error(`Couldn't find an asset compatible with (linux, ${arch}) in the release ${release.tag_name}`);
  }
  return asset;
}

// Extracts files by extension
function extractArchive(downloadPath, outputPath, fileExtension) {
  if (fileExtension === 'gz' || fileExtension === 'tgz') {
    // Refuse archives whose member paths could escape outputPath (absolute
    // paths or '..' segments). Checked explicitly so safety doesn't depend
    // on the host tar implementation's defaults.
    const listing = spawnSync('tar', ['-tzf', downloadPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (listing.status !== 0) throw new Error(`tar exited with code ${listing.status}`);
    assertSafeArchiveMemberNames(listing.stdout, downloadPath);
    const result = spawnSync('tar', ['-xzf', downloadPath, '-C', outputPath], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`tar exited with code ${result.status}`);
    fs.unlinkSync(downloadPath);
  } else if (fileExtension === 'zip') {
    // Refuse archives whose member paths could escape outputPath (absolute
    // paths or '..' segments), mirroring the tar branch above, so safety
    // doesn't depend on the host unzip implementation's defaults.
    const listing = spawnSync('unzip', ['-Z1', downloadPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (listing.status !== 0) throw new Error(`unzip listing exited with code ${listing.status}`);
    assertSafeArchiveMemberNames(listing.stdout, downloadPath);
    const result = spawnSync('unzip', [downloadPath, '-d', outputPath], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`unzip exited with code ${result.status}`);
    fs.unlinkSync(downloadPath);
  } else {
    logger.warn(`Unrecognized file extension: ${fileExtension}. Will not extract.`);
  }
}

// Handles directories structure after extracting the files
function flattenSingleTopLevelDir(outputPath) {
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
        { headers: githubApiHeaders() }
      );
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`Can't find ${owner}/${repoName} repository using github api`);
      }
      throw githubRateLimitError(error) || new Error(`GitHub API Error: ${error.message}`);
    }
  }

  // Returns the most recent release. With verifyHash=true (default), skips releases that have
  // no entry in the hashes file, since an unverified release cannot be installed safely.
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
    // Extract into a staging sibling and swap it in, never into the live tree.
    // downloadReleaseAsset flattens the archive's top-level directory only when
    // it is the sole entry of the output path, so extracting over a previous
    // release's bin/ and share/ left the new release nested one level down: the
    // Dockerfile installed the OLD bin/*, and the version file claimed the new
    // release (litecoind v0.21.4 reported itself under a v0.21.5.6 version file
    // on the regtest rehearsal, 2026-09-03). Staging also keeps the previous
    // tree intact when the download or hash check fails.
    const stagingPath = fullOutputPath + '.staging';

    // Gets the specific release info
    const release = await this.getReleaseByTag(owner, repoName, version);

    if (verifyHash && !this.hasHash(repoKey, version)) {
      throw new Error( `Required SHA-256 hash not found for ${repoKey}@${version}`);
    }

    try {
      if (fs.existsSync(stagingPath)) {
        fs.rmSync(stagingPath, { recursive: true, force: true });
      }
      await this.downloadReleaseAsset(release, stagingPath, repoKey, version, verifyHash);
      fs.writeFileSync(path.join(stagingPath, version_file_name), version)

      if (fs.existsSync(fullOutputPath)) {
        fs.rmSync(fullOutputPath, { recursive: true, force: true });
      }
      fs.renameSync(stagingPath, fullOutputPath);
      return fullOutputPath;
    } catch (error) {
      if (fs.existsSync(stagingPath)) {
        fs.rmSync(stagingPath, { recursive: true, force: true });
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
        { headers: githubApiHeaders() }
      );
      return response.data;
    } catch (error) {
      throw githubRateLimitError(error) || new Error(`Error getting the release ${tag}: ${error.message}`);
    }
  }

  /**
   * Downloads the asset for a linux server matching the host architecture.
   * Picks the release asset whose name contains the host arch ("x86_64" /
   * "aarch64") and "linux" (one of the prebuilt linux-gnu tarballs).
   */
  async downloadReleaseAsset(release, outputPath, repoKey, version, verifyHash) {
    const asset = selectHostLinuxAsset(release);

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

      extractArchive(downloadPath, outputPath, fileExtension);

      flattenSingleTopLevelDir(outputPath);
    } catch (error) {
      throw new Error(`Error downloading asset: ${error.message}`);
    }
  }
}

installMethods(GitHubDownloader.prototype, require('./github_downloader/hash_verification.js'));

module.exports = GitHubDownloader;
