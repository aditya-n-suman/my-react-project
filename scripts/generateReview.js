const fs = require('fs');
const path = require('path');

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
      "line": 123,                 // target new line number
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

const REVIEW_PROMPT_TEMPLATE = `Analyze the code changes and provide:
1. Brief summary (2-3 lines)

Changes to review:
{{diff}}

Format your response in plain json object including these parameters:
SUMMARY:
<brief overview>

CONCERNS:
- <list key issues>

SUGGESTIONS:
- <list actionable improvements>

SECURITY:
- <list security considerations or "No significant security concerns">`;

async function generateReview(diff) {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: SYSTEM_PROMPT,
        prompt: REVIEW_PROMPT_TEMPLATE.replace('{{diff}}', diff),
        stream: false,
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    console.log('Response received from Ollama API', response);

    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error('Review generation failed:', error);
    return null;
  }
}

async function main() {
  try {
    const inputFile = `.webpack-cache/ai-review/last-precommit.json.temp`;
    const outputFile = `.webpack-cache/ai-review/with-review-${Date.now()}.json`;

    // Read input payload
    const payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    
    // Generate reviews for each file
    const reviews = [];
    for (const file of payload.diff.byFile) {
      if (file.diffUnified && !/Binary files/.test(file.diffUnified)) {
        const review = await generateReview(file.diffUnified);
        console.log(`[ai-review] Generated review for ${file.path}`, review);
        if (review) {
          file.review = review;
          reviews.push({
            filePath: file.path,
            review: review
          });
        }
      }
    }

    // Update payload with reviews
    const updatedPayload = {
      ...payload,
      reviews: reviews,
      reviewGeneratedAt: new Date().toISOString()
    };

    // Write updated payload
    fs.writeFileSync(outputFile, JSON.stringify(updatedPayload, null, 2));
    console.log('[ai-review] Reviews generated successfully');
    process.exit(0);
  } catch (error) {
    console.error('[ai-review] Review generation failed:', error);
    process.exit(1);
  }
}

main();
