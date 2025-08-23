// import { execSync } from "child_process";
const sqlite3 = require("sqlite3");
const fs = require("fs");
const path = require("path");
const math = require("mathjs"); // for cosine similarity
const { parse } = require("@babel/parser");
const traverseDefault = require("@babel/traverse");
const traverse = traverseDefault.default || traverseDefault;

const DB_PATH = path.join(process.cwd(), ".cache/codebase.db");

// Add logger utility
const log = {
	step: (msg) => console.log(`\n🔵 ${msg}`),
	success: (msg) => console.log(`✅ ${msg}`),
	warn: (msg) => console.log(`⚠️  ${msg}`),
	error: (msg) => console.error(`❌ ${msg}`),
	info: (msg) => console.log(`ℹ️  ${msg}`),
};

// Run Ollama embedding model
async function embed(text) {
	log.step("Generating embeddings...");
	try {
		const response = await fetch("http://localhost:11434/api/embeddings", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "all-minilm", // Lighter and specialized for embeddings
				prompt: text,
				options: {
					temperature: 0, // Deterministic output for embeddings
				},
			}),
		});

		if (!response.ok) {
			throw new Error(`Embedding request failed: ${response.statusText}`);
		}

		const data = await response.json();
		log.success("Generated embeddings successfully");
		return data.embedding;
	} catch (error) {
		log.error(`Embedding generation failed: ${error.message}`);
		throw error;
	}
}

// Add file type detection
function getFileType(filePath) {
	const ext = path.extname(filePath);
	return {
		isJS: [".js", ".jsx", ".ts", ".tsx"].includes(ext),
		isTS: [".ts", ".tsx"].includes(ext),
		isJSX: [".jsx", ".tsx"].includes(ext),
	};
}

// Modified initDB to not recreate tables if they exist
function initDB() {
	log.step("Initializing database...");
	const dbDir = path.dirname(DB_PATH);
	if (!fs.existsSync(dbDir)) {
		log.info(`Creating directory: ${dbDir}`);
		fs.mkdirSync(dbDir, { recursive: true });
	}

	const db = new sqlite3.Database(DB_PATH);
	log.info(`Connected to database: ${DB_PATH}`);

	// Only create tables if they don't exist
	db.serialize(() => {
		db.run(`CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE,
      content TEXT,
      embedding TEXT,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

		db.run(`CREATE TABLE IF NOT EXISTS variable_refs (
      id INTEGER PRIMARY KEY,
      variable_name TEXT,
      file_path TEXT,
      line_number INTEGER,
      ref_type TEXT,
      source_path TEXT,
      FOREIGN KEY(file_path) REFERENCES docs(path)
    )`);

		db.run(
			"CREATE INDEX IF NOT EXISTS idx_var_name ON variable_refs(variable_name)"
		);
		db.run(
			"CREATE INDEX IF NOT EXISTS idx_file_path ON variable_refs(file_path)"
		);
	});

	log.success("Database initialized successfully");
	return db;
}

// Enhanced variable reference extraction
function extractVariableRefs(content, filePath) {
	log.step(`Extracting variables from ${filePath}`);
	const refs = [];
	const fileType = getFileType(filePath);

	try {
		const ast = parse(content, {
			sourceType: "module",
			plugins: [
				...(fileType.isJSX ? ["jsx"] : []),
				...(fileType.isTS ? ["typescript"] : []),
				"classProperties",
				"exportDefaultFrom",
				"exportNamespaceFrom",
			],
		});

		// Updated traverse usage
		traverse(ast, {
			// Track exports
			ExportNamedDeclaration(path) {
				const declaration = path.node.declaration;
				if (declaration && declaration.declarations) {
					declaration.declarations.forEach((d) => {
						if (d.id.name) {
							refs.push({
								name: d.id.name,
								filePath,
								line: d.loc.start.line,
								type: "export",
							});
						}
					});
				}
			},

			// Track imports
			ImportDeclaration(path) {
				path.node.specifiers.forEach((specifier) => {
					refs.push({
						name: specifier.local.name,
						filePath,
						line: specifier.loc.start.line,
						type: "import",
						source: path.node.source.value,
					});
				});
			},

			// Track variable usage
			Identifier(path) {
				const name = path.node.name;
				// Skip if it's a declaration
				if (path.parent.type.includes("Declaration")) return;

				refs.push({
					name,
					filePath,
					line: path.node.loc.start.line,
					type: "usage",
				});
			},
		});
	} catch (e) {
		log.warn(`Failed to parse ${filePath}: ${e.message}`);
	}
	log.success(`Found ${refs.length} variable references`);
	return refs;
}

// Add file to DB
async function addFile(db, filePath) {
	log.step(`Processing file: ${filePath}`);
	const text = fs.readFileSync(filePath, "utf8");
	log.info(`File size: ${text.length} bytes`);

	const emb = await embed(text);

	db.serialize(() => {
		log.info("Starting database transaction");
		db.run("BEGIN TRANSACTION");
		try {
			// Delete existing records for this file
			db.run("DELETE FROM variable_refs WHERE file_path = ?", filePath);
			db.run("DELETE FROM docs WHERE path = ?", filePath);

			// Insert new records
			db.run("INSERT INTO docs (path, content, embedding) VALUES (?, ?, ?)", [
				filePath,
				text,
				JSON.stringify(emb),
			]);

			const refs = extractVariableRefs(text, filePath);
			const stmt = db.prepare(
				"INSERT INTO variable_refs (variable_name, file_path, line_number, ref_type, source_path) VALUES (?, ?, ?, ?, ?)"
			);

			refs.forEach((ref) => {
				stmt.run(
					ref.name,
					ref.filePath,
					ref.line,
					ref.type || "declaration",
					ref.source || null
				);
			});

			stmt.finalize();
			log.success(`File processed successfully: ${filePath}`);
			db.run("COMMIT");
		} catch (error) {
			db.run("ROLLBACK");
			log.error(`Failed to process file ${filePath}: ${error.message}`);
		}
	});
}

// Cosine similarity
function cosineSim(a, b) {
	const dot = math.dot(a, b);
	const normA = math.norm(a);
	const normB = math.norm(b);
	return dot / (normA * normB);
}

// Modified search to include variable references
async function search(db, query, k = 5) {
	log.step("Searching codebase...");
	log.info(
		`Query: "${query.substring(0, 100)}${query.length > 100 ? "..." : ""}"`
	);

	const qEmb = await embed(query);
	return new Promise((resolve, reject) => {
		log.info("Querying database for relevant files...");
		const sql = `
      SELECT 
        d.path,
        d.content,
        d.embedding,
        json_group_array(
          json_object(
            'name', v.variable_name,
            'line', v.line_number,
            'type', v.ref_type,
            'source', v.source_path
          )
        ) as vars
      FROM docs d
      LEFT JOIN variable_refs v ON d.path = v.file_path
      GROUP BY d.path
    `;

		db.all(sql, [], (err, rows) => {
			if (err) {
				log.error(`Search failed: ${err.message}`);
				return reject(err);
			}

			log.info(`Found ${rows.length} files, calculating relevance...`);
			const scored = rows.map((r) => ({
				path: r.path,
				content: r.content,
				variables: JSON.parse(r.vars).reduce((acc, v) => {
					// Skip if name is empty or a built-in property
					if (!v.name || typeof Object.prototype[v.name] !== "undefined")
						return acc;

					// Initialize array if doesn't exist
					if (!acc[v.name]) {
						acc[v.name] = [];
					}

					// Validate array before pushing
					if (Array.isArray(acc[v.name])) {
						acc[v.name].push({
							line: v.line,
							type: v.type,
							source: v.source,
						});
					}

					return acc;
				}, {}),
				score: cosineSim(qEmb, JSON.parse(r.embedding)),
			}));

			const results = scored.sort((a, b) => b.score - a.score).slice(0, k);
			log.success(`Search complete. Top ${k} results found`);
			resolve(results);
		});
	});
}

async function setupContext(context) {
	log.step("Setting up AI context...");
	try {
		const response = await fetch("http://localhost:11434/api/generate", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "qwen2.5-coder",
				prompt: `You are a coding assistant. Here is the codebase context you should remember:\n\n${context}\n\nUse this context to answer upcoming questions.`,
				context: [], // Initialize fresh context
				stream: false,
			}),
		});

		const data = await response.json();
		log.success("Context setup complete");
		return data.context;
	} catch (error) {
		log.error(`Context setup failed: ${error.message}`);
		throw error;
	}
}

async function queryOllama(query, context) {
	log.step("Querying Ollama...");
	try {
		const response = await fetch("http://localhost:11434/api/generate", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "qwen2.5-coder",
				prompt: query,
				context: context,
				stream: false,
			}),
		});

		const data = await response.json();
		log.success("Query successful");
		return {
			response: data.response,
			context: data.context,
		};
	} catch (error) {
		log.error(`Query failed: ${error.message}`);
		throw error;
	}
}

let currentContext = null;

async function askQwen(query, refreshContext = false) {
	log.step(`Processing query: "${query}"`);
	const db = initDB();

	log.info("Searching for relevant context...");
	const results = await search(db, query);

	log.info(`Building context from ${results.length} files...`);
	const contextText = results
		.map((r) => `${r.path}:\n${r.content}`)
		.join("\n\n");

	// Setup fresh context if needed
	if (!currentContext || refreshContext) {
		log.info(
			refreshContext ? "Refreshing context..." : "Initializing new context..."
		);
		currentContext = await setupContext(contextText);
	}

	log.info("Generating response...");
	const result = await queryOllama(query, currentContext);
	currentContext = result.context;

	log.success("Response generated successfully");
	await cleanup(db);
	return result.response;
}

// Add cleanup function
function cleanup(db) {
	log.step("Cleaning up resources...");
	return new Promise((resolve, reject) => {
		db.close((err) => {
			if (err) {
				log.error(`Cleanup failed: ${err.message}`);
				reject(err);
			} else {
				log.success("Cleanup complete");
				resolve();
			}
		});
	});
}

// --- Example Usage ---
// (Run once per file to build index)
// const db = initDB();
// addFile(db, "./src/App.tsx");
// addFile(db, "./server/index.js");

module.exports = { initDB, addFile, search, askQwen, cleanup, DB_PATH };
