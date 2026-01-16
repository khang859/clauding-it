#!/usr/bin/env node
/**
 * Copy Skill - Downloads Claude Code skills from GitHub repositories
 *
 * Usage:
 *   node copy-skill.js <github-url> [--target <path>] [--name <name>] [--verbose]
 *
 * Examples:
 *   node copy-skill.js https://github.com/user/repo/tree/main/skills/my-skill
 *   node copy-skill.js https://github.com/user/repo/tree/main/skills/my-skill --target ~/.claude/skills
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse command line arguments
function parseArgs(args) {
  const result = {
    url: null,
    target: '.claude/skills',
    name: null,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--target' || arg === '-t') {
      result.target = args[++i];
    } else if (arg === '--name' || arg === '-n') {
      result.name = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (!arg.startsWith('-') && !result.url) {
      result.url = arg;
    }
  }

  return result;
}

// Parse GitHub URL to extract components
function parseGitHubUrl(url) {
  // Handle various GitHub URL formats
  // https://github.com/owner/repo/tree/branch/path/to/skill
  // https://github.com/owner/repo/tree/main/skills/skill-name

  const patterns = [
    // tree URL: github.com/owner/repo/tree/branch/path
    /github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)\/(.+)/,
    // blob URL: github.com/owner/repo/blob/branch/path
    /github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        branch: match[3],
        path: match[4].replace(/\/$/, '') // Remove trailing slash
      };
    }
  }

  throw new Error(`Invalid GitHub URL format: ${url}`);
}

// Make HTTPS request with Promise
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'copy-skill-cli',
        'Accept': 'application/vnd.github.v3+json',
        ...headers
      }
    };

    // Add GitHub token if available
    if (process.env.GITHUB_TOKEN) {
      options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    https.get(url, options, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ data, contentType: res.headers['content-type'] });
        } else if (res.statusCode === 403 && data.includes('rate limit')) {
          reject(new Error('GitHub API rate limit exceeded. Set GITHUB_TOKEN environment variable.'));
        } else if (res.statusCode === 404) {
          reject(new Error(`Not found: ${url}`));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

// Fetch directory contents from GitHub API
async function fetchDirectoryContents(owner, repo, path, branch) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const { data } = await httpsGet(apiUrl);
  return JSON.parse(data);
}

// Fetch raw file content
async function fetchFileContent(owner, repo, path, branch) {
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const { data } = await httpsGet(rawUrl);
  return data;
}

// Recursively fetch all files in a directory
async function fetchAllFiles(owner, repo, basePath, branch, verbose = false) {
  const files = [];

  async function fetchRecursive(currentPath) {
    if (verbose) {
      console.log(`  Scanning: ${currentPath}`);
    }

    const contents = await fetchDirectoryContents(owner, repo, currentPath, branch);

    for (const item of contents) {
      if (item.type === 'file') {
        if (verbose) {
          console.log(`    Found file: ${item.path}`);
        }
        files.push({
          path: item.path,
          relativePath: item.path.replace(basePath + '/', ''),
          downloadUrl: item.download_url
        });
      } else if (item.type === 'dir') {
        await fetchRecursive(item.path);
      }
    }
  }

  await fetchRecursive(basePath);
  return files;
}

// Create directory recursively
function mkdirRecursive(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// Expand ~ to home directory
function expandPath(filePath) {
  if (filePath.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE, filePath.slice(1));
  }
  return filePath;
}

// Main function
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.log('Usage: node copy-skill.js <github-url> [--target <path>] [--name <name>] [--verbose]');
    console.log('');
    console.log('Examples:');
    console.log('  node copy-skill.js https://github.com/user/repo/tree/main/skills/my-skill');
    console.log('  node copy-skill.js https://github.com/user/repo/tree/main/skills/my-skill --target ~/.claude/skills');
    process.exit(1);
  }

  try {
    console.log('Copy Skill - GitHub to Local');
    console.log('============================\n');

    // Parse URL
    const { owner, repo, branch, path: skillPath } = parseGitHubUrl(args.url);
    const skillName = args.name || skillPath.split('/').pop();

    console.log(`Repository: ${owner}/${repo}`);
    console.log(`Branch: ${branch}`);
    console.log(`Path: ${skillPath}`);
    console.log(`Skill name: ${skillName}`);
    console.log('');

    // Fetch all files
    console.log('Fetching files from GitHub...');
    const files = await fetchAllFiles(owner, repo, skillPath, branch, args.verbose);
    console.log(`Found ${files.length} file(s)\n`);

    if (files.length === 0) {
      throw new Error('No files found in the specified directory');
    }

    // Determine target directory
    const targetBase = expandPath(args.target);
    const targetDir = path.join(targetBase, skillName);

    console.log(`Target: ${targetDir}\n`);
    console.log('Downloading files...');

    // Download and write each file
    for (const file of files) {
      const content = await fetchFileContent(owner, repo, file.path, branch);
      const targetPath = path.join(targetDir, file.relativePath);
      const targetFileDir = path.dirname(targetPath);

      // Create directory if needed
      if (!fs.existsSync(targetFileDir)) {
        mkdirRecursive(targetFileDir);
      }

      // Write file
      fs.writeFileSync(targetPath, content);
      console.log(`  ✓ ${file.relativePath}`);
    }

    console.log('\n============================');
    console.log('Skill copied successfully!');
    console.log(`Location: ${targetDir}`);
    console.log('\nRestart Claude Code to load the new skill.');

  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (args.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
