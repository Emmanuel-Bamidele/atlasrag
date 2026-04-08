from supavector import Client


def main() -> None:
    client = Client.from_env(collection="default")

    client.index_text(
        "quickstart",
        "SupaVector stores semantic memories for agents.",
        params={"idempotencyKey": "py-quickstart-1"},
    )

    docs = client.list_docs()
    print("docs", docs["data"]["docs"])

    search = client.search("semantic", {"k": 3})
    print("search", search["data"]["results"])

    answer = client.ask("What does SupaVector store?", {"k": 7})
    print("answer", answer["data"]["answer"])

    boolean_ask = client.boolean_ask(
        "Does SupaVector store semantic memories for agents?",
        {"k": 7},
    )
    print("boolean_ask", boolean_ask["data"]["answer"])
    print("supportingChunks", boolean_ask["data"]["supportingChunks"])


if __name__ == "__main__":
    main()
