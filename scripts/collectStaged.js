#!/usr/bin/env node
/*
 Collect staged git changes and write a JSON payload for AI code review.
 Optionally POST the payload to a local review server.

 Env flags:
 - AI_REVIEW_ENABLED=true|false (default: true)
 - AI_REVIEW_POST=true|false (default: true)
 - AI_REVIEW_SERVER_URL=http://localhost:5959/pre-commit
 - AI_REVIEW_OUTPUT_FILE=.webpack-cache/ai-review/last-precommit.json
 - AI_REVIEW_FAIL_ON_ERROR=true|false (default: false)
*/

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function getEnvFlag(name, def) {
  const val = process.env[name];
  if (val == null) return def;
  return String(val).toLowerCase() === 'true' || String(val) === '1';
}

const ENABLED = getEnvFlag('AI_REVIEW_ENABLED', true);
const SHOULD_POST = getEnvFlag('AI_REVIEW_POST', true);
const FAIL_ON_ERROR = getEnvFlag('AI_REVIEW_FAIL_ON_ERROR', false);
const SERVER_URL = process.env.AI_REVIEW_SERVER_URL || 'http://localhost:5959/pre-commit';
const OUTPUT_FILE = process.env.AI_REVIEW_OUTPUT_FILE || path.join('.webpack-cache', 'ai-review', 'last-precommit.json');

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

function collectGitInfo() {
  const inside = safeRun('git rev-parse --is-inside-work-tree');
  if (inside !== 'true') {
    throw new Error('Not inside a git work tree.');
  }

  const root = safeRun('git rev-parse --show-toplevel');
  const branch = safeRun('git rev-parse --abbrev-ref HEAD') || 'HEAD';
  const head = safeRun('git rev-parse HEAD');
  const userName = safeRun('git config user.name');
  const userEmail = safeRun('git config user.email');

  return { root, branch, head, userName, userEmail };
}

function collectStagedFiles() {
  // name-status gives lines like: "M\tpath" or "R100\told\tnew"
  const out = safeRun('git diff --cached --name-status');
  const lines = out ? out.split(/\r?\n/) : [];
  const files = [];
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(/\t/);
    const status = parts[0];
    if (status.startsWith('R')) {
      const from = parts[1];
      const to = parts[2];
      files.push({ status: 'R', path: to, previousPath: from });
    } else {
      const filePath = parts[1];
      files.push({ status, path: filePath });
    }
  }
  return files;
}

function collectNumstat() {
  // lines: added\tdeleted\tpath
  const out = safeRun('git diff --cached --numstat');
  const lines = out ? out.split(/\r?\n/) : [];
  const byPath = new Map();
  let totalAdd = 0;
  let totalDel = 0;
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(/\t/);
    const addStr = parts[0];
    const delStr = parts[1];
    const filePath = parts[2];
    const added = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
    const deleted = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
    totalAdd += added;
    totalDel += deleted;
    byPath.set(filePath, { added, deleted });
  }
  return { byPath, totals: { added: totalAdd, deleted: totalDel } };
}

function collectUnifiedDiff() {
  // unified=0 keeps hunks minimal while still parseable
  const diff = safeRun('git diff --cached --unified=0 --no-color');
  return diff;
}

function detectLanguageFromPath(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'html':
    case 'htm':
    case 'ejs':
      return 'html';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return ext || 'unknown';
  }
}

function isBinaryDiffText(diffText) {
  return /\nBinary files .* differ\n?/.test(diffText);
}

function collectPerFileDiff(filePath, options = { ignoreWhitespace: false }) {
  const flags = options.ignoreWhitespace ? ' -w --ignore-blank-lines' : '';
  const cmd = `git diff --cached --unified=0 --no-color${flags} -- ${JSON.stringify(filePath)}`;
  const diffText = safeRun(cmd);
  return diffText;
}

function parseHunksAddedLines(diffText) {
  // Parses unified diff and returns hunks with added lines and their new line numbers
  // Structure: [{ rangeNew: { start, count }, additions: [{ line, content }] }]
  const hunks = [];
  if (!diffText || isBinaryDiffText(diffText)) return hunks;
  const lines = diffText.split(/\r?\n/);
  let idx = 0;
  let currentNewLine = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    // Find hunk header
    const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (m) {
      const hunkNewStart = parseInt(m[1], 10);
      const hunkNewCount = m[2] ? parseInt(m[2], 10) : 1;
      currentNewLine = hunkNewStart;
      idx += 1;
      const additions = [];
      // Read hunk body until next hunk/header or EOF
      while (idx < lines.length && !lines[idx].startsWith('@@') && !lines[idx].startsWith('diff --git ')) {
        const body = lines[idx];
        if (body.startsWith(' ')) {
          // context line
          currentNewLine += 1;
        } else if (body.startsWith('+')) {
          additions.push({ line: currentNewLine, content: body.slice(1) });
          currentNewLine += 1;
        } else if (body.startsWith('-')) {
          // deletion; does not advance new line
        } else if (body.startsWith('\\ No newline at end of file')) {
          // ignore
        }
        idx += 1;
      }
      hunks.push({ rangeNew: { start: hunkNewStart, count: hunkNewCount }, additions });
      continue;
    }
    idx += 1;
  }
  return hunks;
}

function extractTodoFixme(additionsByFile) {
  const results = [];
  const re = /\b(TODO|FIXME|HACK|XXX)\b[:\- ]?(.*)/i;
  for (const item of additionsByFile) {
    const { path: filePath, hunks } = item;
    for (const h of hunks) {
      for (const add of h.additions) {
        const m = re.exec(add.content);
        if (m) {
          results.push({ file: filePath, line: add.line, tag: m[1].toUpperCase(), text: (m[2] || '').trim() });
        }
      }
    }
  }
  return results;
}

function attachStats(files, numstatMap) {
  return files.map((f) => {
    const stat = numstatMap.get(f.path) || { added: 0, deleted: 0 };
    return { ...f, added: stat.added, deleted: stat.deleted };
  });
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function postJson(urlStr, data, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const req = lib.request(
        {
          method: 'POST',
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + (u.search || ''),
          headers: {
            'content-type': 'application/json',
          },
          timeout: timeoutMs,
        },
        (res) => {
          // Drain response
          res.resume();
          resolve({ statusCode: res.statusCode });
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify(data));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function spawnReviewGenerator(inputFile, outputFile) {
  const reviewScript = path.join(__dirname, 'generateReview.js');
  
  const child = spawn('node', [reviewScript, inputFile, outputFile], {
    detached: true,
    stdio: 'ignore'
  });

  // Unref the child to allow the parent to exit independently
  child.unref();
}

async function main() {
  if (!ENABLED) {
    process.exit(0);
  }
  try {
    const git = collectGitInfo();
    const stagedFiles = collectStagedFiles();
    if (stagedFiles.length === 0) {
      // Nothing to do
      process.exit(0);
    }
    const numstat = collectNumstat();
    const filesWithStats = attachStats(stagedFiles, numstat.byPath);
    const unifiedDiff = collectUnifiedDiff();

    // Build per-file diffs and additions with line numbers
    const perFile = [];
    for (const file of filesWithStats) {
      const language = detectLanguageFromPath(file.path);
      const diffUnified = collectPerFileDiff(file.path, { ignoreWhitespace: false });
      const diffUnifiedNoWs = collectPerFileDiff(file.path, { ignoreWhitespace: true });
      const hunks = parseHunksAddedLines(diffUnified);
      perFile.push({
        path: file.path,
        status: file.status,
        previousPath: file.previousPath || null,
        language,
        added: file.added,
        deleted: file.deleted,
        diffUnified,
        diffUnifiedNoWhitespace: diffUnifiedNoWs,
        hunks,
      });
    }

    const todoFixme = extractTodoFixme(perFile);

    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      repo: {
        root: git.root,
        branch: git.branch,
        head: git.head || null,
      },
      author: {
        name: git.userName || null,
        email: git.userEmail || null,
      },
      staged: {
        numFiles: filesWithStats.length,
        totals: numstat.totals,
        files: filesWithStats,
      },
      diff: {
        unified: unifiedDiff,
        byFile: perFile,
      },
      notes: {
        todoFixme,
      },
      meta: {
        cwd: process.cwd(),
        node: process.version,
      },
    };

    // Write initial payload
    const tempOutputFile = OUTPUT_FILE + '.temp';
    writeJson(tempOutputFile, payload);

    if (SHOULD_POST) {
      try {
        // Post initial payload without reviews
        await postJson(SERVER_URL, payload, 3000);
      } catch (e) {
        // Best-effort: do not block commit when server is down
      }
    }

    process.exit(0);
  } catch (e) {
    // Print concise error but do not block by default
    console.error('[ai-review][collector] Error:', e && e.message ? e.message : e);
    process.exit(FAIL_ON_ERROR ? 1 : 0);
  }
}

main();


