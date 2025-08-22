const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const hooksDir = path.join(__dirname, '../.husky');
const localHooksDir = path.join(__dirname, '../hooks');

// Create .husky directory if it doesn't exist
if (!fs.existsSync(hooksDir)) {
  execSync('npx husky install');
}

// Setup pre-commit hook
const preCommitContent = fs.readFileSync(path.join(localHooksDir, 'pre-commit'), 'utf-8');
execSync(`npx husky add .husky/pre-commit "${preCommitContent.replace(/\n/g, ';')}"`);

// Setup pre-push hook
const prePushContent = fs.readFileSync(path.join(localHooksDir, 'pre-push'), 'utf-8');
execSync(`npx husky add .husky/pre-push "${prePushContent.replace(/\n/g, ';')}"`);

console.log('Git hooks setup completed!');
