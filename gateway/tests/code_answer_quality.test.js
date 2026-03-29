const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks: indexHooks } = require("../index");
const { __testHooks: answerHooks } = require("../answer");

function testBuildCodeRetrievalQueryIncludesPathHints() {
  const query = indexHooks.buildCodeRetrievalQuery(
    "How does src/auth/session.ts connect validateSession to authMiddleware in app/server.js?",
    {
      task: "debug",
      errorMessage: "Failure in src/auth/session.ts line 42"
    }
  );

  assert.match(query, /file hints .*src\/auth\/session\.ts/i);
  assert.match(query, /app\/server\.js/i);
  assert.match(query, /identifiers .*validateSession.*authMiddleware/i);
}

function testSelectCodeCandidatesForPromptPrefersFileDiversity() {
  const ranked = [
    { result: { chunkId: "a#0" }, file: { repo: "acme/app", path: "src/a.ts", docId: "a", language: "ts" }, score: 9 },
    { result: { chunkId: "a#1" }, file: { repo: "acme/app", path: "src/a.ts", docId: "a", language: "ts" }, score: 8.8 },
    { result: { chunkId: "a#2" }, file: { repo: "acme/app", path: "src/a.ts", docId: "a", language: "ts" }, score: 8.6 },
    { result: { chunkId: "b#0" }, file: { repo: "acme/app", path: "src/b.ts", docId: "b", language: "ts" }, score: 8.4 },
    { result: { chunkId: "c#0" }, file: { repo: "acme/app", path: "src/c.ts", docId: "c", language: "ts" }, score: 8.2 },
    { result: { chunkId: "d#0" }, file: { repo: "acme/app", path: "src/d.ts", docId: "d", language: "ts" }, score: 8.0 }
  ];

  const selected = indexHooks.selectCodeCandidatesForPrompt(ranked, 4, { task: "structure" });
  const selectedPaths = selected.map((candidate) => candidate.file.path);

  assert.deepEqual(selectedPaths, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
}

function testBuildCodePromptIncludesRetrievedFileSummary() {
  const prompt = answerHooks.buildCodePrompt(
    "How does authentication work?",
    [
      {
        chunk_id: "default::repo::auth#0",
        source_type: "code",
        title: "src/auth.ts",
        metadata: {
          repo: "acme/app",
          branch: "main",
          path: "src/auth.ts",
          language: "typescript"
        },
        text: "export function validateSession(token) { return token.startsWith('sess_'); }"
      }
    ],
    "long",
    {
      task: "understand",
      files: [
        {
          path: "src/auth.ts",
          repo: "acme/app",
          branch: "main",
          language: "typescript",
          exports: ["validateSession"],
          functions: ["validateSession"],
          imports: ["./tokens"]
        }
      ],
      sourceSummary: {
        repositories: ["acme/app"],
        languages: ["typescript"],
        codeHits: 1,
        nonCodeHits: 0
      },
      relationshipSummary: {
        connections: [
          "src/server.ts imports src/auth.ts",
          "src/server.ts calls validateSession from src/auth.ts"
        ]
      }
    }
  );

  assert.match(prompt.user, /Retrieved files:/);
  assert.match(prompt.user, /src\/auth\.ts/);
  assert.match(prompt.user, /exports: validateSession/);
  assert.match(prompt.user, /Retrieved source summary:/);
  assert.match(prompt.user, /Retrieved relationships:/);
  assert.match(prompt.user, /calls validateSession from src\/auth\.ts/);
  assert.match(prompt.system, /Synthesize across multiple retrieved files/);
  assert.match(prompt.system, /trace imports, exports, routes, handlers, and likely call edges explicitly/);
}

function testExtractCodeStructureMetadataCapturesConnections() {
  const metadata = indexHooks.extractCodeStructureMetadata(`
import { validateSession } from "./auth/session";
const router = require("./router");

export function loginHandler(req, res) {
  validateSession(req.headers.authorization);
}

router.get("/health", healthHandler);
`, { language: "typescript" });

  assert.deepEqual(metadata.exports, ["loginHandler"]);
  assert.deepEqual(metadata.imports, ["./auth/session", "./router"]);
  assert.deepEqual(metadata.routes, ["GET /health"]);
  assert.ok(metadata.functions.includes("loginHandler"));
  assert.ok(metadata.calls.includes("validateSession"));
}

function testBuildCodeRelationshipSummaryTracesImportsAndCalls() {
  const summary = indexHooks.buildCodeRelationshipSummary([
    {
      path: "src/server.ts",
      exports: [],
      functions: ["startServer"],
      classes: [],
      imports: ["./auth/session"],
      modules: ["./auth/session"],
      calls: ["validateSession"],
      routes: ["GET /health"]
    },
    {
      path: "src/auth/session.ts",
      exports: ["validateSession"],
      functions: ["validateSession"],
      classes: [],
      imports: [],
      modules: [],
      calls: [],
      routes: []
    }
  ], {
    question: "What connects src/server.ts to validateSession?"
  });

  assert.ok(summary.entryPoints.some((line) => /src\/server\.ts exposes GET \/health/.test(line)));
  assert.ok(summary.connections.some((line) => /src\/server\.ts imports src\/auth\/session\.ts/.test(line)));
  assert.ok(summary.connections.some((line) => /src\/server\.ts calls validateSession from src\/auth\/session\.ts/.test(line)));
}

function main() {
  testBuildCodeRetrievalQueryIncludesPathHints();
  testSelectCodeCandidatesForPromptPrefersFileDiversity();
  testBuildCodePromptIncludesRetrievedFileSummary();
  testExtractCodeStructureMetadataCapturesConnections();
  testBuildCodeRelationshipSummaryTracesImportsAndCalls();
  console.log("code answer quality tests passed");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
