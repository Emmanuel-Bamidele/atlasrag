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

  const write = await client.memoryWrite({
    text: "Use Redis for low-latency vector lookups.",
    type: "memory",
    policy: "amvl",
    title: "Vector lookup guidance",
    visibility: "private",
    acl: ["user:alice", "svc:agent-api"],
    idempotencyKey: "mem-write-1"
  });

  console.log("memory write", write.data.memory.id);

  const recall = await client.memoryRecall({
    query: "How do we do low-latency vector search?",
    k: 3,
    policy: "amvl",
    types: ["memory"]
  });

  console.log("memory recall", recall.data.results.length);

  await client.indexText("artifact_doc", "SupaVector keeps artifacts and reflects them into semantic memory.");
  const reflect = await client.memoryReflect({
    docId: "artifact_doc",
    policy: "amvl",
    types: ["semantic", "summary"],
    maxItems: 2,
    visibility: "acl",
    acl: ["user:alice", "svc:agent-api"],
    idempotencyKey: "mem-reflect-1"
  });

  console.log("reflect job", reflect.data.job.id);

  const job = await client.getJob(reflect.data.job.id);
  console.log("job status", job.data.job.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
