from supavector import Client


def main() -> None:
    client = Client.from_env()

    result = client.index_folder(
        "./customer-support",
        params={
            "idempotencyKey": "py-folder-001",
        },
    )

    print("indexed", result["indexedCount"])
    print("errors", result["errorCount"])
    for item in result["indexed"]:
        print(item["path"], item["docId"])


if __name__ == "__main__":
    main()
