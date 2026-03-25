const { SupaVectorClient } = require("../src");

const client = new SupaVectorClient({
  baseUrl: process.env.SUPAVECTOR_URL || "http://localhost:3000",
  collection: process.env.SUPAVECTOR_COLLECTION || "default"
});

async function main() {
  const username = process.env.SUPAVECTOR_USER;
  const password = process.env.SUPAVECTOR_PASS;
  if (!username || !password) {
    throw new Error("Set SUPAVECTOR_USER and SUPAVECTOR_PASS in your environment.");
  }

  await client.login(username, password);

  await client.indexText("quickstart", "SupaVector stores semantic memories for agents.", {
    idempotencyKey: "idx-quickstart-1"
  });

  const docs = await client.listDocs();
  console.log("docs", docs.data.docs);

  const search = await client.search("semantic", { k: 3 });
  console.log("search", search.data.results);

  const answer = await client.ask("What does SupaVector store?", { k: 3 });
  console.log("answer", answer.data.answer);

  const booleanAsk = await client.booleanAsk("Does SupaVector store semantic memories for agents?", { k: 3 });
  console.log("boolean_ask", booleanAsk.data.answer);
  console.log("supportingChunks", booleanAsk.data.supportingChunks);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
