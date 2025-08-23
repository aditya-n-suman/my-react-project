const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { initDB, search, cleanup, DB_PATH } = require('./contextExtractor.js');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder';

const SYSTEM_PROMPT = `You are “AI Frontend Quality Guardian” for a React/TypeScript PWA. Review ONLY the provided staged changes. Prioritize correctness, security, accessibility, performance, and developer experience.
 
Project specifics:
- Stack: React 18, TypeScript, Redux/Thunk, Webpack 5, PWA service worker.
- Patterns: Mobile-first responsive design, proper state management, API error handling, image optimization & lazy loading, SEO/meta tags, service worker hygiene.
- Linting/Style: ES6+, no var, prefer const/let, proper TS types (avoid any), clear naming, idiomatic React hooks (no rule violations), semantic HTML, CSS without !important, prefer CSS modules.
 
Scope & input:
- You receive a JSON payload from a pre-commit collector with:
  - diff.byFile[].{path,status,language,added,deleted,diffUnified,diffUnifiedNoWhitespace,hunks[{rangeNew,additions[{line,content}]}]}
  - staged.files[] counts, repo/author meta, notes.todoFixme[]
- Focus your analysis on added/changed lines using hunks.additions[line, content]. Use the unified diff as context. Do NOT speculate beyond shown changes unless a critical adjacent issue is obvious.
 
Categories to check (label each finding with one primary category):
- code_health: unused imports, dead code, console logs, missing keys, bad naming, brittle logic.
- accessibility: alt/aria/roles/labels, keyboard focus/semantics, color contrast hints.
- seo: meta tags, headings structure, link semantics, preloading/lazy loading hints.
- tech_debt: TODO/FIXME/HACK surfaced from notes.todoFixme or new additions.
- security: XSS/HTML injection, unsafe URL handling, secrets, SSRF/csrf hints.
- performance: unnecessary re-renders, heavy sync work, missing memoization, image size/lazy loading, expensive loops.
 
Output requirements (JSON only):
{
  "annotations": [
    {
      "file": "string",            // exact file path
      "line": 123,                 // target new line number (new file numbering)
      "severity": "must-fix" | "should-fix" | "nit",
      "category": "code_health" | "accessibility" | "seo" | "tech_debt" | "security" | "performance",
      "message": "concise human-readable issue",
      "suggestion": "brief actionable fix",
      "ruleId": "optional short tag (e.g., react-hooks/exhaustive-deps)"
    }
  ],
  "autofixes": [
    {
      "file": "string",
      "patch": "unified diff applying only safe, localized changes",
      "notes": "when helpful, explain edge cases or alternatives"
    }
  ],
  "summaryMarkdown": "short, skimmable report grouped by category with counts"
}
 
Rules:
- Annotate only lines present in hunks.additions. If context is needed, reference it succinctly.
- Prefer minimal, precise patches. Do not refactor unrelated code.
- If uncertain or missing context, add an annotation with severity \"should-fix\" and include \"needs-context\" in notes.
- Keep messages specific, testable, and aligned to the project’s rules above.
- Avoid duplicating findings for the same line/category; merge where reasonable.
`

const REVIEW_PROMPT_TEMPLATE = `You will receive a unified diff for a single file along with relevant codebase context. 
Consider the impact of changes on existing code when reviewing.

CODEBASE CONTEXT:
{{context}}

VARIABLE REFERENCES:
{{variables}}

FILE BEING REVIEWED (UNIFIED DIFF):
{{diff}}

Rules:
- Consider how changes affect existing variable usage and dependencies
- Check for breaking changes in exports/imports
- Verify consistency with existing patterns
- Output ONLY the JSON object. No code fences, no backticks, no prose before/after.
- Use NEW file line numbers from the diff for annotations.
- Only annotate lines that are additions in the diff (lines starting with '+').
- Keep changes minimal and localized. If unsure, add an annotation with severity "should-fix" and include "needs-context" in suggestion.


Produce ONE strict JSON object ONLY, following exactly this schema:
{
  "annotations": Array<{
    "file": string,
    "line": number,
    "severity": "must-fix" | "should-fix" | "nit",
    "category": "code_health" | "accessibility" | "seo" | "tech_debt" | "security" | "performance",
    "message": string,
    "suggestion": string,
    "ruleId"?: string
  }>,
  "autofixes": Array<{
    "file": string,
    "patch": string,
    "notes"?: string
  }>,
  "summaryMarkdown": string
}`;

function stripCodeFences(text) {
  if (typeof text !== 'string') return '';
  // remove typical ```json ... ``` or ``` ... ``` wrappers
  const fenceRe = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/m;
  const m = fenceRe.exec(text.trim());
  return m ? m[1] : text.trim();
}

function extractJsonObject(text) {
  const cleaned = stripCodeFences(text);
  // Try a straight parse first
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  // Fallback: extract the first {...} block heuristically
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = cleaned.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  return null;
}

function coerceSchema(obj, filePath) {
  const out = obj && typeof obj === 'object' ? obj : {};
  if (!Array.isArray(out.annotations)) out.annotations = [];
  if (!Array.isArray(out.autofixes)) out.autofixes = [];
  if (typeof out.summaryMarkdown !== 'string') out.summaryMarkdown = '';
  // Normalize fields inside annotations/autofixes
  out.annotations = out.annotations.map((a) => ({
    file: a && typeof a.file === 'string' ? a.file : filePath,
    line: typeof a?.line === 'number' ? a.line : 0,
    severity: a?.severity === 'must-fix' || a?.severity === 'should-fix' || a?.severity === 'nit' ? a.severity : 'should-fix',
    category: ['code_health','accessibility','seo','tech_debt','security','performance'].includes(a?.category) ? a.category : 'code_health',
    message: typeof a?.message === 'string' ? a.message : 'Unparsed model output',
    suggestion: typeof a?.suggestion === 'string' ? a.suggestion : 'needs-context',
    ...(a?.ruleId ? { ruleId: a.ruleId } : {})
  }));
  out.autofixes = out.autofixes.map((f) => ({
    file: f && typeof f.file === 'string' ? f.file : filePath,
    patch: typeof f?.patch === 'string' ? f.patch : '',
    ...(typeof f?.notes === 'string' ? { notes: f.notes } : {})
  }));
  return out;
}

// Add logger utility
const log = {
  step: (msg) => console.log(`\n🔵 ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.log(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  info: (msg) => console.log(`ℹ️  ${msg}`)
};

async function generateReviewForFile(db, filePath, diff) {
  log.step(`Generating review for ${filePath}`);
  try {
    // Check if DB exists
    if (!fs.existsSync(DB_PATH)) {
      throw new Error('Codebase index not found. Please run npm install to initialize the codebase context.');
    }
    
    log.info('Searching for relevant files...');
    const searchResults = await search(db, diff, 3);
    log.info(`Found ${searchResults.length} relevant files`);
    
    log.info('Building context...');
    const contextText = searchResults.map(r => `File: ${r.path}\n${r.content}`).join('\n\n');
    const variablesText = searchResults.map(r => {
      const vars = Object.entries(r.variables)
        .map(([name, refs]) => `${name}: ${refs.map(ref => 
          `${ref.type} at line ${ref.line}${ref.source ? ` (from ${ref.source})` : ''}`
        ).join(', ')}`)
        .join('\n');
      return `${r.path}:\n${vars}`;
    }).join('\n\n');

    log.info('Requesting AI review...');
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: SYSTEM_PROMPT,
        prompt: REVIEW_PROMPT_TEMPLATE
          .replace('{{context}}', contextText)
          .replace('{{variables}}', variablesText)
          .replace('{{diff}}', diff),
        stream: false,
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    log.info('Parsing AI response...');
    const parsed = extractJsonObject(data.response);
    
    if (!parsed) {
      log.warn('Failed to parse AI response');
      return coerceSchema({ summaryMarkdown: 'Model response could not be parsed to JSON.' }, filePath);
    }

    const result = coerceSchema(parsed, filePath);
    log.success(`Review complete: ${result.annotations.length} annotations, ${result.autofixes.length} suggested fixes`);
    return result;

  } catch (error) {
    log.error(`Review generation failed: ${error.message}`);
    return coerceSchema({ 
      summaryMarkdown: `Failed to access codebase context: ${error.message}` 
    }, filePath);
  }
}

async function main() {
  log.step('Starting AI code review');
  let db = null;
  try {
    const inputFile = process.argv[2] || `.webpack-cache/ai-review/last-precommit-input.json`;
    const outputFile = process.argv[3] || `.webpack-cache/ai-review/commit-with-review.json`;

    log.info(`Reading input from ${inputFile}`);
    const payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

    log.info('Loading codebase context...');
    db = initDB();
    
    log.info(`Processing ${payload.diff.byFile.length} changed files...`);
    const reviews = [];
    for (const file of payload.diff.byFile) {
      if (file.diffUnified && !/Binary files/.test(file.diffUnified)) {
        const review = await generateReviewForFile(db, file.path, file.diffUnified);
        file.review = review;
        reviews.push({ filePath: file.path, review });
      }
    }

    log.info('Saving review results...');
    const updatedPayload = {
      ...payload,
      reviews: reviews,
      reviewGeneratedAt: new Date().toISOString()
    };

    fs.writeFileSync(outputFile, JSON.stringify(updatedPayload, null, 2));
    log.success(`Reviews saved to ${outputFile}`);
    process.exit(0);
  } catch (error) {
    log.error(`Review process failed: ${error.message}`);
    process.exit(1);
  } finally {
    if (db) {
      log.info('Cleaning up database connection...');
      await cleanup(db);
    }
  }
}

main();
