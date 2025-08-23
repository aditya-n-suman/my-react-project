#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function toMdHeader(text, level = 2) {
  const hashes = '#'.repeat(Math.max(1, Math.min(6, level)));
  return `${hashes} ${text}`;
}

function escapeMd(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAnnotation(idx, a) {
  const sev = a.severity || 'should-fix';
  const cat = a.category || 'code_health';
  const loc = typeof a.line === 'number' && a.line > 0 ? `L${a.line}` : 'unknown line';
  const rule = a.ruleId ? ` (${a.ruleId})` : '';
  const message = escapeMd(a.message || '');
  const suggestion = escapeMd(a.suggestion || '');
  return `- **[${sev}] [${cat}]** at ${loc}${rule}
  - **Issue**: ${message}
  - **Suggestion**: ${suggestion}`;
}

function renderFileSection(fileEntry) {
  const lines = [];
  const filePath = fileEntry.filePath;
  const review = fileEntry.review || {};
  const summary = review.summaryMarkdown || '';
  const annotations = Array.isArray(review.annotations) ? review.annotations : [];
  const autofixes = Array.isArray(review.autofixes) ? review.autofixes : [];

  lines.push(toMdHeader(filePath, 3));
  if (summary) {
    lines.push('');
    lines.push(summary.trim());
  }

  if (annotations.length) {
    lines.push('');
    lines.push(toMdHeader('Findings', 4));
    lines.push('');
    // Group by category for readability
    const byCategory = annotations.reduce((acc, a) => {
      const key = a.category || 'code_health';
      acc[key] = acc[key] || [];
      acc[key].push(a);
      return acc;
    }, {});
    for (const category of Object.keys(byCategory)) {
      lines.push(`- **${category}**:`);
      const items = byCategory[category]
        .sort((x, y) => (x.line || 0) - (y.line || 0))
        .map((a, i) => renderAnnotation(i + 1, a));
      lines.push(...items.map(s => `  ${s}`));
    }
  }

  if (autofixes.length) {
    lines.push('');
    lines.push(toMdHeader('Proposed patches', 4));
    for (const fix of autofixes) {
      const notes = fix.notes ? `\n\nNotes: ${escapeMd(fix.notes)}` : '';
      lines.push('');
      lines.push(`- File: ${fix.file || filePath}`);
      lines.push('');
      lines.push('```diff');
      lines.push(fix.patch || '');
      lines.push('```');
      if (notes) lines.push(notes);
    }
  }

  return lines.join('\n');
}

function renderReport(payload) {
  const lines = [];
  const repo = payload.repo || {};
  const staged = payload.staged || {};
  const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];

  lines.push('# AI Code Review Report');
  lines.push('');
  lines.push(`- **Repository**: ${repo.root || ''}`);
  lines.push(`- **Branch**: ${repo.branch || ''}`);
  lines.push(`- **Commit**: ${repo.head || ''}`);
  lines.push(`- **Generated At**: ${payload.reviewGeneratedAt || payload.generatedAt || ''}`);
  lines.push('');
  lines.push(`- **Staged Files**: ${staged.numFiles ?? reviews.length}`);
  lines.push('');

  // High-level counts by category and severity
  const allAnnotations = reviews.flatMap(r => (r.review && Array.isArray(r.review.annotations)) ? r.review.annotations.map(a => ({...a, file: a.file || r.filePath})) : []);
  const countsByCategory = allAnnotations.reduce((acc, a) => {
    const key = a.category || 'code_health';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const countsBySeverity = allAnnotations.reduce((acc, a) => {
    const key = a.severity || 'should-fix';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  if (allAnnotations.length) {
    lines.push('## Summary');
    lines.push('');
    lines.push('- **By category**:');
    for (const k of Object.keys(countsByCategory)) {
      lines.push(`  - **${k}**: ${countsByCategory[k]}`);
    }
    lines.push('- **By severity**:');
    for (const k of Object.keys(countsBySeverity)) {
      lines.push(`  - **${k}**: ${countsBySeverity[k]}`);
    }
    lines.push('');
  }

  for (const entry of reviews) {
    lines.push(renderFileSection(entry));
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

function main() {
  const inputFile = process.argv[2] || path.join('.webpack-cache', 'ai-review', 'commit-with-review.json');
  const outputFile = process.argv[3] || path.join('.webpack-cache', 'ai-review', 'reviews.md');
  const payload = readJson(inputFile);
  const md = renderReport(payload);
  ensureDir(outputFile);
  fs.writeFileSync(outputFile, md, 'utf8');
  console.log(`[ai-review] Markdown report written to ${outputFile}`);

  // Optionally open the report in the current editor/window
  const shouldOpen = (process.env.AI_REVIEW_OPEN || 'true').toLowerCase() !== 'false' && process.env.CI !== 'true';
  if (shouldOpen) {
    // List of editors to try in order
    const editors = [
      ['cursor', ['-r']],    // Cursor
      ['code', ['-r']],      // VS Code
      ['vim', []],           // Vim
      ['nano', []],          // Nano
      ['xdg-open', []],      // Linux default
      ['open', []]           // macOS default
    ];

    const tryNextEditor = (index) => {
      if (index >= editors.length) {
        console.warn('[ai-review] No suitable editor found to open the report');
        console.info(`[ai-review] Report location: ${outputFile}`);
        return;
      }

      const [cmd, args] = editors[index];
      try {
        const child = spawn(cmd, [...args, outputFile], {
          detached: true,
          stdio: 'ignore'
        });

        child.on('error', () => {
          console.info(`[ai-review] Editor ${cmd} not available, trying next...`);
          tryNextEditor(index + 1);
        });

        child.unref();
        console.log(`[ai-review] Opening markdown report with ${cmd}...`);
      } catch (error) {
        console.info(`[ai-review] Failed to spawn ${cmd}, trying next...`);
        tryNextEditor(index + 1);
      }
    };

    tryNextEditor(0);
  }
}

main();


