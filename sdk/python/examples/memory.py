from supavector import Client


def main() -> None:
    client = Client.from_env(collection="default")

    write = client.memory_write(
        {
            "text": "Use Redis for low-latency vector lookups.",
            "type": "semantic",
            "policy": "amvl",
            "title": "Vector lookup guidance",
            "visibility": "private",
            "acl": ["user:alice", "svc:agent-api"],
            "idempotencyKey": "py-mem-write-1",
        }
    )
    print("memory write", write["data"]["memory"]["id"])

    recall = client.memory_recall(
        {
            "query": "How do we do low-latency vector search?",
            "k": 3,
            "policy": "amvl",
            "types": ["semantic"],
        }
    )
    print("memory recall", len(recall["data"]["results"]))

    client.index_text(
        "artifact_doc",
        "SupaVector keeps artifacts and reflects them into semantic memory.",
        params={"idempotencyKey": "py-artifact-doc-1"},
    )
    reflect = client.memory_reflect(
        {
            "docId": "artifact_doc",
            "policy": "amvl",
            "types": ["semantic", "summary"],
            "maxItems": 2,
            "visibility": "acl",
            "acl": ["user:alice", "svc:agent-api"],
            "idempotencyKey": "py-mem-reflect-1",
        }
    )
    print("reflect job", reflect["data"]["job"]["id"])

    job = client.get_job(reflect["data"]["job"]["id"])
    print("job status", job["data"]["job"]["status"])


if __name__ == "__main__":
    main()
