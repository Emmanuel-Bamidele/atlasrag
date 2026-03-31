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

function testBuildCodeRetrievalQueryIncludesWorkingSetContext() {
  const query = indexHooks.buildCodeRetrievalQuery(
    "Where should I continue the auth redirect fix?",
    {
      task: "debug",
      context: {
        codeSession: {
          workingSet: {
            files: ["src/auth/session.ts", "src/middleware.ts"],
            repositories: ["acme/web"],
            symbols: ["validateSession", "authMiddleware"]
          },
          recentTurns: [
            {
              question: "Why is validateSession redirecting twice?",
              task: "debug",
              files: ["src/auth/session.ts"]
            }
          ]
        }
      }
    }
  );

  assert.match(query, /working set files .*src\/auth\/session\.ts.*src\/middleware\.ts/i);
  assert.match(query, /working set repositories .*acme\/web/i);
  assert.match(query, /working set symbols .*validateSession.*authMiddleware/i);
  assert.match(query, /recent code questions .*redirecting twice/i);
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

function testBuildCodePromptIncludesWorkingSetAndRecentTurns() {
  const prompt = answerHooks.buildCodePrompt(
    "Where should I keep digging for the auth bug?",
    [
      {
        chunk_id: "default::repo::auth#0",
        source_type: "code",
        title: "src/auth/session.ts",
        metadata: {
          repo: "acme/app",
          branch: "main",
          path: "src/auth/session.ts",
          language: "typescript"
        },
        text: "export function validateSession(token) { return token.startsWith('sess_'); }"
      }
    ],
    "medium",
    {
      task: "debug",
      workingSet: {
        files: ["src/auth/session.ts", "src/middleware.ts"],
        repositories: ["acme/app"],
        symbols: ["validateSession", "authMiddleware"]
      },
      context: {
        codeSession: {
          currentTask: "debug",
          recentTurns: [
            {
              question: "Why is validateSession redirecting twice?",
              task: "debug",
              files: ["src/auth/session.ts"],
              symbols: ["validateSession"],
              answerSummary: "The redirect likely starts in validateSession before middleware runs."
            }
          ]
        }
      }
    }
  );

  assert.match(prompt.user, /Active working set:/);
  assert.match(prompt.user, /src\/auth\/session\.ts/);
  assert.match(prompt.user, /src\/middleware\.ts/);
  assert.match(prompt.user, /Recent code session turns:/);
  assert.match(prompt.user, /Why is validateSession redirecting twice\?/);
  assert.match(prompt.user, /The redirect likely starts in validateSession before middleware runs\./);
  assert.match(prompt.system, /continue from that working set/i);
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

function testExtractCodeStructureMetadataCapturesRepoSignals() {
  const packageMetadata = indexHooks.extractCodeStructureMetadata(`
{
  "name": "@acme/api",
  "scripts": {
    "dev": "node server.js",
    "test": "vitest run"
  },
  "workspaces": ["packages/*", "apps/*"]
}
`, { language: "json", path: "package.json" });

  assert.equal(packageMetadata.packageName, "@acme/api");
  assert.deepEqual(packageMetadata.scripts, ["dev", "test"]);
  assert.deepEqual(packageMetadata.workspacePackages, ["packages/*", "apps/*"]);
  assert.equal(packageMetadata.isConfigFile, true);
  assert.ok(packageMetadata.configKinds.includes("package"));

  const composeMetadata = indexHooks.extractCodeStructureMetadata(`
services:
  gateway:
    image: supavector
  worker:
    image: supavector-worker
`, { path: "docker-compose.yml" });

  assert.deepEqual(composeMetadata.services, ["gateway", "worker"]);
  assert.equal(composeMetadata.isConfigFile, true);
  assert.ok(composeMetadata.configKinds.includes("docker"));
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

function testBuildCodeRelationshipSummaryIncludesRuntimeAndTests() {
  const summary = indexHooks.buildCodeRelationshipSummary([
    {
      path: "package.json",
      exports: [],
      functions: [],
      classes: [],
      imports: [],
      modules: [],
      calls: [],
      routes: [],
      packageName: "@acme/api",
      scripts: ["dev", "test"],
      workspacePackages: ["packages/*"],
      isConfigFile: true
    },
    {
      path: "docker-compose.yml",
      exports: [],
      functions: [],
      classes: [],
      imports: [],
      modules: [],
      calls: [],
      routes: [],
      services: ["gateway"],
      envVars: ["OPENAI_API_KEY"],
      isConfigFile: true
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
    },
    {
      path: "tests/auth/session.test.ts",
      exports: [],
      functions: ["shouldValidateSession"],
      classes: [],
      imports: ["../src/auth/session"],
      modules: ["../src/auth/session"],
      calls: ["validateSession"],
      routes: [],
      testTargets: ["../src/auth/session"],
      isTestFile: true
    }
  ], {
    question: "Which package defines the runtime service and what test covers validateSession?"
  });

  assert.ok(summary.packageBoundaries.some((line) => /package\.json defines package @acme\/api/.test(line)));
  assert.ok(summary.runtimeSignals.some((line) => /docker-compose\.yml defines service gateway/.test(line)));
  assert.ok(summary.testLinks.some((line) => /tests\/auth\/session\.test\.ts tests src\/auth\/session\.ts/.test(line)));
}

function testBuildCodeScoreBoostPrefersRepoSignalsForFocusedQuestions() {
  const testBoost = indexHooks.buildCodeScoreBoost(
    "Which test covers validateSession?",
    {
      path: "tests/auth/session.test.ts",
      isTestFile: true,
      testTargets: ["../src/auth/session"],
      functions: ["shouldValidateSession"]
    },
    {}
  );
  const codeBoost = indexHooks.buildCodeScoreBoost(
    "Which test covers validateSession?",
    {
      path: "src/auth/session.ts",
      functions: ["validateSession"]
    },
    {}
  );
  assert.ok(testBoost > codeBoost);

  const configBoost = indexHooks.buildCodeScoreBoost(
    "Where is OPENAI_API_KEY configured for the docker stack?",
    {
      path: "docker-compose.yml",
      isConfigFile: true,
      configKinds: ["docker"],
      services: ["gateway"],
      envVars: ["OPENAI_API_KEY"]
    },
    {}
  );
  const genericBoost = indexHooks.buildCodeScoreBoost(
    "Where is OPENAI_API_KEY configured for the docker stack?",
    {
      path: "src/server.ts",
      functions: ["startServer"]
    },
    {}
  );
  assert.ok(configBoost > genericBoost);
}

function testBuildCodeWorkingSetMergesSessionAndRetrievedFiles() {
  const workingSet = indexHooks.buildCodeWorkingSet([
    {
      path: "src/server.ts",
      repo: "acme/app",
      language: "typescript",
      exports: [],
      functions: ["startServer"],
      classes: []
    }
  ], {
    context: {
      codeSession: {
        workingSet: {
          files: ["src/auth/session.ts"],
          repositories: ["acme/app"],
          symbols: ["validateSession"]
        }
      }
    }
  });

  assert.ok(workingSet.files.includes("src/auth/session.ts"));
  assert.ok(workingSet.files.includes("src/server.ts"));
  assert.ok(workingSet.repositories.includes("acme/app"));
  assert.ok(workingSet.symbols.includes("validateSession"));
  assert.ok(workingSet.symbols.includes("startServer"));
}

function main() {
  testBuildCodeRetrievalQueryIncludesPathHints();
  testBuildCodeRetrievalQueryIncludesWorkingSetContext();
  testSelectCodeCandidatesForPromptPrefersFileDiversity();
  testBuildCodePromptIncludesRetrievedFileSummary();
  testBuildCodePromptIncludesWorkingSetAndRecentTurns();
  testExtractCodeStructureMetadataCapturesConnections();
  testExtractCodeStructureMetadataCapturesRepoSignals();
  testBuildCodeRelationshipSummaryTracesImportsAndCalls();
  testBuildCodeRelationshipSummaryIncludesRuntimeAndTests();
  testBuildCodeScoreBoostPrefersRepoSignalsForFocusedQuestions();
  testBuildCodeWorkingSetMergesSessionAndRetrievedFiles();
  console.log("code answer quality tests passed");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
