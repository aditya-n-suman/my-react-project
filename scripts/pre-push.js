#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = process.env.AI_REVIEW_OUTPUT_FILE || path.join('.webpack-cache', 'ai-review', 'last-prepush.json');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function safeRun(cmd) {
  try {
    return run(cmd);
  } catch (e) {
    return '';
  }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function collectGitInfo() {
  const root = safeRun('git rev-parse --show-toplevel');
  const branch = safeRun('git rev-parse --abbrev-ref HEAD') || 'HEAD';
  const head = safeRun('git rev-parse HEAD');
  const upstream = safeRun('git rev-parse @{u}') || null;
  const userName = safeRun('git config user.name');
  const userEmail = safeRun('git config user.email');

  return { root, branch, head, upstream, userName, userEmail };
}

function collectCommitsToPush() {
  const range = '@{u}..HEAD';
  const format = '--pretty=format:{%n  "hash": "%H",%n  "subject": "%s",%n  "body": "%b",%n  "author": "%aN",%n  "email": "%aE",%n  "date": "%aI"%n}';
  
  try {
    const output = safeRun(`git log ${range} ${format}`);
    if (!output) return [];
    
    return output
      .split('\n}\n{')
      .map(str => str.replace(/^\{|\}$/g, ''))
      .map(str => JSON.parse(`{${str}}`));
  } catch (e) {
    return [];
  }
}

function collectChangedFiles() {
  const range = '@{u}..HEAD';
  const output = safeRun(`git diff ${range} --name-status`);
  const lines = output ? output.split('\n') : [];
  
  return lines.map(line => {
    const [status, path] = line.split('\t');
    return { status, path };
  }).filter(x => x.path);
}

async function main() {
  try {
    // Run checks first
    console.log('Running type checking...');
    execSync('npm run type-check', { stdio: 'inherit' });

    console.log('Running tests...');
    execSync('npm run test', { stdio: 'inherit' });

    console.log('Running build...');
    execSync('npm run build', { stdio: 'inherit' });

    // Collect push information
    const git = collectGitInfo();
    const commitsToPush = collectCommitsToPush();
    const changedFiles = collectChangedFiles();

    if (commitsToPush.length === 0) {
      console.log('No commits to push');
      process.exit(0);
    }

    // Generate report
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      repo: {
        root: git.root,
        branch: git.branch,
        head: git.head,
        upstream: git.upstream
      },
      author: {
        name: git.userName,
        email: git.userEmail
      },
      push: {
        numCommits: commitsToPush.length,
        commits: commitsToPush,
        files: changedFiles
      },
      meta: {
        cwd: process.cwd(),
        node: process.version
      }
    };

    writeJson(OUTPUT_FILE, payload);
    console.log(`Push analysis written to ${OUTPUT_FILE}`);
    console.log('Pre-push checks passed');
    process.exit(0);
  } catch (e) {
    console.error('[pre-push] Error:', e.message || e);
    process.exit(1);
  }
}

main();
