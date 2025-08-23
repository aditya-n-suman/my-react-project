import { initDB, addFile } from './contextExtractor.js';
import fs from 'fs';
import path from 'path';

const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build'];
const CODE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.h', '.cs'];

async function processDirectory(db, dirPath) {
  const files = fs.readdirSync(dirPath);
  
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (!IGNORE_DIRS.includes(file)) {
        await processDirectory(db, fullPath);
      }
    } else if (CODE_EXTENSIONS.includes(path.extname(file))) {
      console.log(`Processing: ${fullPath}`);
      await addFile(db, fullPath);
    }
  }
}

async function main() {
  console.log('Initializing codebase context...');
  const db = initDB();
  
  try {
    await processDirectory(db, path.resolve('./'));
    console.log('Codebase context initialization complete!');
  } catch (error) {
    console.error('Failed to initialize codebase:', error);
    process.exit(1);
  }
}

main();
