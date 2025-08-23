import { execSync } from "child_process";
import sqlite3 from "sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = "codebase.db";
const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build'];
const CODE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.h', '.cs'];

function embed(text) {
  const result = execSync(`echo ${JSON.stringify(text)} | ollama run nomic-embed-text`);
  return JSON.parse(result.toString());
}

function initDB() {
  const db = new sqlite3.Database(DB_PATH);
  db.run("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, path TEXT, content TEXT, embedding TEXT)");
  return db;
}

function addFile(db, filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const emb = embed(text);
  db.run("INSERT INTO docs (path, content, embedding) VALUES (?, ?, ?)", 
         [filePath, text, JSON.stringify(emb)]);
}

function processDirectory(db, dirPath) {
  const files = fs.readdirSync(dirPath);
  
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (!IGNORE_DIRS.includes(file)) {
        processDirectory(db, fullPath);
      }
    } else if (CODE_EXTENSIONS.includes(path.extname(file))) {
      console.log(`Processing: ${fullPath}`);
      addFile(db, fullPath);
    }
  }
}

// Main initialization function
function initializeCodebase(repoPath) {
  const db = initDB();
  processDirectory(db, repoPath);
  console.log("Codebase initialization complete!");
}

// Usage
const repoPath = process.argv[2];
if (!repoPath) {
  console.error("Please provide repository path");
  process.exit(1);
}

initializeCodebase(repoPath);
