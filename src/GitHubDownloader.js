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
const { execSync } = require('child_process');
const util = require('util');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);

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
      
      // Validates structure
      for (const [repo, versions] of Object.entries(data)) {
        if (typeof versions !== 'object') {
          throw new Error(`Invalid hash format for ${repo}`);
        }
        for (const [version, hash] of Object.entries(versions)) {
          if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
            throw new Error(`Invalid SHA-256 hash for ${repo}@${version}`);
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
   * Downloads the asset for a linux server
   */
  async downloadReleaseAsset(release, outputPath, repoKey, version, verifyHash) {
    // Finds the asset that has (linux, x86, 64)
    const asset = release.assets.find(asset => 
      asset.name.toLowerCase().includes('x86') &&
      asset.name.toLowerCase().includes('64') &&
      asset.name.toLowerCase().includes('linux')
    );

    if (!asset) {
      throw new Error(`Couldn't find an asset compatible with (linux, x86, 64) in the release ${release.tag_name}`);
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
        execSync(`tar -xzf ${downloadPath} -C ${outputPath} && rm ${downloadPath}`, {
          stdio: 'inherit'
        });
      } else if (fileExtension === 'zip') {
        execSync(`unzip ${downloadPath} -d ${outputPath} && rm ${downloadPath}`, {
          stdio: 'inherit'
        });
      } else {
        console.warn(`Extensión de archivo no reconocida: ${fileExtension}. No se extraerá.`);
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
   * Checks if hash exists for a version
   */
  hasHash(repoKey, version) {
    return !!this.hashesData[repoKey]?.[version];
  }

  /**
   * Verifies repository hash against stored value
   */
  async verifyRepositoryHash(repoKey, version, repoPath) {
    const expectedHash = this.hashesData[repoKey][version];
    const actualHash = await this.calculateDirectoryHash(repoPath);
    
    if (actualHash !== expectedHash) {
      throw new Error(`Hash verification failed for ${repoKey}@${version}\nExpected: ${expectedHash}\nActual: ${actualHash}`);
    }
    
    console.log(`✅ Hash verified for ${repoKey}@${version}`);
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