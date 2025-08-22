#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ...existing code for helper functions like getEnvFlag, run, safeRun, ensureDir...

const OUTPUT_FILE = process.env.AI_REVIEW_OUTPUT_FILE || path.join('.webpack-cache', 'ai-review', 'last-precommit.json');
const FAIL_ON_ERROR = getEnvFlag('AI_REVIEW_FAIL_ON_ERROR', false);

async function main() {
  try {
    // Run linting
    console.log('Running linting...');
    execSync('npm run lint', { stdio: 'inherit' });

    // Collect git info and changes
    const git = collectGitInfo();
    const stagedFiles = collectStagedFiles();
    
    if (stagedFiles.length === 0) {
      console.log('No files staged for commit');
      process.exit(0);
    }

    const numstat = collectNumstat();
    const filesWithStats = attachStats(stagedFiles, numstat.byPath);
    const todoFixme = extractTodoFixme(perFile);

    // Write report
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      repo: {
        root: git.root,
        branch: git.branch,
        head: git.head || null,
      },
      staged: {
        numFiles: filesWithStats.length,
        totals: numstat.totals,
        files: filesWithStats,
      },
      notes: { todoFixme },
    };

    writeJson(OUTPUT_FILE, payload);
    console.log('Pre-commit checks passed');
    process.exit(0);
  } catch (e) {
    console.error('[pre-commit] Error:', e && e.message ? e.message : e);
    process.exit(FAIL_ON_ERROR ? 1 : 0);
  }
}

main();
