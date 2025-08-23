#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'patch';
}

function writeFileSafe(filePath, content) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, content, 'utf8');
}

function openInEditor(targetPaths) {
  const tryOpen = (cmd, args) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch (_) {
      return false;
    }
  };
  const args = Array.isArray(targetPaths) ? targetPaths : [targetPaths];
  return (
    tryOpen('cursor', ['-r', ...args]) ||
    tryOpen('code', ['-r', ...args]) ||
    tryOpen('xdg-open', [args[0]]) ||
    tryOpen('open', [args[0]])
  );
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGitApply(patchPath, { checkOnly = false } = {}) {
  try {
    const flags = checkOnly ? '--check' : '';
    run(`git apply ${flags} --whitespace=fix --3way ${JSON.stringify(patchPath)}`);
    return true;
  } catch (e) {
    return false;
  }
}

function main() {
  const inputFile = process.argv[2] || path.join('.webpack-cache', 'ai-review', 'commit-with-review.json');
  const outCombined = process.argv[3] || path.join('.webpack-cache', 'ai-review', 'autofixes.patch');
  const patchesDir = path.join('.webpack-cache', 'ai-review', 'patches');
  const shouldOpen = (process.env.AI_REVIEW_OPEN || 'true').toLowerCase() !== 'false' && process.env.CI !== 'true';
  const shouldApply = (process.env.AI_REVIEW_APPLY || 'false').toLowerCase() === 'true';

  const payload = readJson(inputFile);
  const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];

  const individual = [];
  let combined = '';
  let count = 0;

  for (const entry of reviews) {
    const filePath = entry.filePath;
    const review = entry.review || {};
    const fixes = Array.isArray(review.autofixes) ? review.autofixes : [];
    for (const [idx, fix] of fixes.entries()) {
      const patch = typeof fix.patch === 'string' ? fix.patch.trim() : '';
      if (!patch) continue;
      const baseName = sanitizeName(`${path.basename(filePath)}_${idx + 1}`);
      const outPath = path.join(patchesDir, `${baseName}.patch`);
      writeFileSafe(outPath, patch + (patch.endsWith('\n') ? '' : '\n'));
      combined += patch + (patch.endsWith('\n') ? '' : '\n');
      individual.push(outPath);
      count += 1;
    }
  }

  writeFileSafe(outCombined, combined);

  if (count === 0) {
    console.log('[ai-review] No autofix patches found in review JSON.');
  } else {
    console.log(`[ai-review] Wrote ${count} patch(es):`);
    for (const p of individual) console.log(` - ${p}`);
    console.log(`[ai-review] Combined patch: ${outCombined}`);
  }

  if (shouldOpen) {
    const opened = openInEditor([outCombined, ...individual]);
    if (opened) console.log('[ai-review] Opening patches in editor...');
  }

  if (shouldApply && count > 0) {
    const ok = tryGitApply(outCombined, { checkOnly: true });
    if (!ok) {
      console.log('[ai-review] Patch does not apply cleanly (check failed). Skipping apply.');
      process.exit(2);
    }
    const applied = tryGitApply(outCombined, { checkOnly: false });
    if (applied) {
      console.log('[ai-review] Patch applied successfully. Staged changes are ready to commit.');
    } else {
      console.log('[ai-review] Failed to apply patch.');
      process.exit(3);
    }
  }
}

main();


