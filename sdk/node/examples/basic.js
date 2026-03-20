const { AtlasRAGClient } = require("../src");

const client = new AtlasRAGClient({
  baseUrl: process.env.ATLASRAG_URL || "http://localhost:3000",
  collection: process.env.ATLASRAG_COLLECTION || "default"
});

async function main() {
  const username = process.env.ATLASRAG_USER;
  const password = process.env.ATLASRAG_PASS;
  if (!username || !password) {
    throw new Error("Set ATLASRAG_USER and ATLASRAG_PASS in your environment.");
  }

  await client.login(username, password);

  await client.indexText("quickstart", "AtlasRAG stores semantic memories for agents.", {
    idempotencyKey: "idx-quickstart-1"
  });

  const docs = await client.listDocs();
  console.log("docs", docs.data.docs);

  const search = await client.search("semantic", { k: 3 });
  console.log("search", search.data.results);

  const answer = await client.ask("What does AtlasRAG store?", { k: 3 });
  console.log("answer", answer.data.answer);

  const booleanAsk = await client.booleanAsk("Does AtlasRAG store semantic memories for agents?", { k: 3 });
  console.log("boolean_ask", booleanAsk.data.answer);
  console.log("supportingChunks", booleanAsk.data.supportingChunks);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
