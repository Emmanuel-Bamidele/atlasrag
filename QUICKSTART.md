# AtlasRAG Developer Quickstart

This guide shows the **recommended first path** for a developer who wants to:

1. SSH into a **cloud VM**
2. Set up **AtlasRAG with the CLI** on that server
3. Build and deploy an app that calls AtlasRAG **server-to-server**
4. Run the app behind **Gunicorn + Nginx**
5. Use the same pattern on **AWS, Azure, or GCP**

It focuses on the cleanest production pattern first. Other deployment approaches become much easier once you understand this one.

---

## 1) Choose the right mode first

Before you touch a server, decide which mode you are using.

### Recommended for your first real app
**Self-host AtlasRAG on a VM and keep AtlasRAG behind your backend.**

That means:
- AtlasRAG runs on your VM
- your app runs on the same VM or another VM
- your app talks to AtlasRAG over private/server-side HTTP
- the browser never sees the AtlasRAG service token

This is the **backend-as-caller** pattern.

---

## 2) What you need before starting

On your VM, you should have:
- Ubuntu or another Linux VM
- Docker and Docker Compose available
- a domain name if you want public HTTPS
- ports/firewall configured for SSH and your app
- Python if your app uses Gunicorn

You also need to know one important rule:

> `atlasrag onboard` is for **bootstrapping your own self-hosted AtlasRAG deployment**.
>
> Do **not** run it on a machine that is only consuming an already-running AtlasRAG deployment.

---

## 3) High-level architecture

The simplest production shape is:

```text
User -> Nginx -> Gunicorn app -> AtlasRAG API
```

Typical local/private ports on one VM:
- **Nginx**: `80/443`
- **Your app (Gunicorn)**: `127.0.0.1:8000`
- **AtlasRAG**: `127.0.0.1:3000`

This keeps AtlasRAG private and lets your app call it server-to-server.

---

## 4) Step-by-step: self-host on a cloud VM

These steps apply whether the VM is on **AWS, Azure, or GCP**.

### Step 1 — SSH into your server

AWS example:

```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

Generic example:

```bash
ssh ubuntu@YOUR_SERVER_IP
```

### Step 2 — Install Docker and basic tools

Example for Ubuntu:

```bash
sudo apt update
sudo apt install -y curl git ca-certificates gnupg lsb-release
```

Install Docker using your normal OS/vendor-approved method.

### Step 3 — Install AtlasRAG CLI and bootstrap the instance

Typical flow:

```bash
./scripts/install.sh
atlasrag onboard
```

During onboarding, AtlasRAG will prompt for the initial setup and create the **first admin** and the **first service token** for the self-hosted deployment.

### Step 4 — Verify the service is up

Once onboarding is complete, set the runtime env values and check health:

```bash
export ATLASRAG_BASE_URL="http://127.0.0.1:3000"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"

curl -fsS "${ATLASRAG_BASE_URL}/v1/health"
```

### Step 5 — Index a test document

```bash
curl -X POST "${ATLASRAG_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "Idempotency-Key: idx-001" \
  -H "Content-Type: application/json" \
  -d '{
    "docId": "welcome",
    "collection": "default",
    "text": "AtlasRAG stores memory for agents."
  }'
```

### Step 6 — Ask your first question

```bash
curl -X POST "${ATLASRAG_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"question":"What does AtlasRAG store?","k":3}'
```

If that works, your AtlasRAG server is ready for your app.

---

## 5) Do not rely on manual `export` in production

For quick testing, `export` is fine.

For production, store env vars in one of these places instead:
- a `systemd` service file
- an `.env` file loaded by your app process
- AWS Secrets Manager / SSM Parameter Store
- Azure Key Vault
- GCP Secret Manager

At minimum, your app runtime needs:

```bash
ATLASRAG_BASE_URL=http://127.0.0.1:3000
ATLASRAG_API_KEY=YOUR_SERVICE_TOKEN
```

Do not commit these secrets to Git.

---

## 6) Build your app with server-to-server calls

Your frontend or browser should call **your backend**.

Your backend should call **AtlasRAG**.

### Recommended flow
1. User signs in to your app
2. User uploads text or a document
3. Your backend calls AtlasRAG `/v1/docs`
4. User asks a question
5. Your backend calls AtlasRAG `/v1/ask`
6. Your backend returns the result to the frontend

### Why this is the recommended pattern
- your AtlasRAG token stays private
- you can add billing, limits, and logging
- you can revoke access centrally
- you can swap internal infrastructure later

---

## 7) Example backend call pattern

### Python example

```python
import os
import requests

ATLASRAG_BASE_URL = os.environ["ATLASRAG_BASE_URL"]
ATLASRAG_API_KEY = os.environ["ATLASRAG_API_KEY"]

headers = {
    "X-API-Key": ATLASRAG_API_KEY,
    "Content-Type": "application/json",
}


def index_text(doc_id: str, text: str, collection: str = "default"):
    resp = requests.post(
        f"{ATLASRAG_BASE_URL}/v1/docs",
        headers={**headers, "Idempotency-Key": f"idx-{doc_id}"},
        json={
            "docId": doc_id,
            "collection": collection,
            "text": text,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def ask(question: str, collection: str = "default"):
    resp = requests.post(
        f"{ATLASRAG_BASE_URL}/v1/ask",
        headers=headers,
        json={
            "question": question,
            "collection": collection,
            "k": 3,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()
```

---

## 8) Deploy the app with Gunicorn + Nginx

### Example Gunicorn command

```bash
gunicorn app:app --bind 127.0.0.1:8000 --workers 3
```

### Example Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Recommended next step:
- add HTTPS with Let’s Encrypt or your cloud load balancer

---

## 9) AWS, Azure, and GCP: same pattern, different VM product

The deployment model is almost identical across clouds.

### AWS
Use:
- **EC2** for the VM
- **Security Groups** for network rules
- **EBS** for storage
- optional **Secrets Manager** or **SSM Parameter Store** for secrets

### Azure
Use:
- **Azure Virtual Machine**
- **Network Security Group** for firewall rules
- **Managed Disks** for storage
- **Azure Key Vault** for secrets

### GCP
Use:
- **Compute Engine VM**
- **VPC Firewall Rules**
- **Persistent Disk** for storage
- **Secret Manager** for secrets

### The app pattern stays the same everywhere

```text
Cloud VM -> AtlasRAG + your backend -> Nginx -> public traffic
```

So the cloud-specific difference is mostly:
- VM provisioning
- firewall/security rules
- secret storage
- load balancer / TLS options

The AtlasRAG app pattern does not materially change.

---

## 10) Recommended first app to build

Build the smallest useful product first:

### MVP
**Upload a document -> ask questions -> get answers**

Pages:
- `/upload`
- `/ask`

Backend endpoints:
- `POST /upload` -> calls AtlasRAG `/v1/docs`
- `POST /ask` -> calls AtlasRAG `/v1/ask`

This is the fastest path from working infrastructure to a real demo.

---

## 11) Using an existing AtlasRAG deployment

If you **did not install AtlasRAG on this server**, you can still use it by connecting to an existing deployment.

There are two common scenarios:

### Option 1 — AtlasRAG Hosted

If you already obtained a service token from **AtlasRAG hosted** and want to use that hosted deployment, you do **not** run `atlasrag onboard` on your server.

You should already have:
- `ATLASRAG_BASE_URL`
- `ATLASRAG_API_KEY` (service token)

Set them on your server:

```bash
export ATLASRAG_BASE_URL="https://YOUR_HOSTED_ATLASRAG_BASE_URL"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
```

Now call AtlasRAG from your backend exactly the same way:

```bash
curl -X POST "${ATLASRAG_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"question":"What does AtlasRAG store?","k":3}'
```

In this mode:
- no local AtlasRAG bootstrap is needed
- no local Docker stack is needed just to consume the API
- your app still uses the same server-to-server pattern

### Option 2 — Your own self-hosted AtlasRAG elsewhere

If you or your team already deployed AtlasRAG somewhere else, the procedure is almost the same.

Examples:
- AtlasRAG runs on another EC2 instance
- AtlasRAG runs on an Azure VM
- AtlasRAG runs on a GCP VM
- AtlasRAG runs on any other server you control

In that case:
1. get the base URL of that deployment
2. get a service token created on that deployment
3. store both on your app server
4. call AtlasRAG from your backend

Example:

```bash
export ATLASRAG_BASE_URL="http://YOUR_EXISTING_ATLASRAG_SERVER:3000"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
```

Then call it exactly the same way:

```bash
curl -X POST "${ATLASRAG_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "docId": "example",
    "collection": "default",
    "text": "AtlasRAG stores memory for agents."
  }'
```

### Important rules for both cases

- Do **not** run `atlasrag onboard` on a machine that is only consuming an existing deployment
- Service tokens are **deployment-specific**
- A token from one deployment will **not** work on another deployment
- Keep `ATLASRAG_API_KEY` server-side only
- Do not expose service tokens in frontend code

### Summary table

| Scenario | What you do |
|---|---|
| Hosted AtlasRAG | Use the hosted base URL + hosted service token |
| Self-hosted elsewhere | Use that deployment’s base URL + that deployment’s service token |
| Self-hosting on this server | Run `atlasrag onboard` and use the local service token |

---

## 12) Other approaches become straightforward after this

Once you understand the main pattern above, these other modes are easy:

### A. Existing shared deployment
You are only a consumer.
You do not self-host AtlasRAG.
You just get a base URL and service token from the admin.

### B. Hosted deployment + your own model keys
You use an existing deployment while sending your own provider key on supported routes.
That is useful if you want AtlasRAG to keep the data/runtime layer, but you want your own LLM billing.

### C. Full self-host with external Postgres
This is still self-hosting.
The only difference is where AtlasRAG stores relational state.

### D. Human admin setup
Use `/v1/login` only when a human admin needs interactive access, tenant settings, or wants to mint service tokens.
It is not the usual long-running runtime credential for apps.

---

## 13) Common mistakes to avoid

- Running `atlasrag onboard` on a machine that is only consuming an existing hosted/shared deployment
- Putting long-lived service tokens in browser code
- Treating username/password as the main app credential instead of service tokens
- Forgetting that tokens are deployment-scoped
- Committing `ATLASRAG_API_KEY` to Git
- Exposing AtlasRAG directly when your own backend can proxy it safely

---

## 14) The shortest possible checklist

### If you are self-hosting on a VM
1. SSH into the VM
2. Install Docker
3. Install AtlasRAG CLI
4. Run `atlasrag onboard`
5. Save `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY`
6. Verify `/v1/health`
7. Test `/v1/docs` and `/v1/ask`
8. Deploy your backend with Gunicorn
9. Put Nginx in front
10. Keep AtlasRAG token server-side only

### If you are consuming an existing AtlasRAG deployment
1. Get base URL from the hosted provider or admin
2. Get service token from that same deployment
3. Store both on your backend
4. Call AtlasRAG server-to-server
5. Do not run onboarding locally

---

## 15) Final recommendation

For your first serious deployment, do this:

- self-host AtlasRAG on one VM, or use a hosted AtlasRAG deployment you already have access to
- run your backend on the same VM or a second VM
- keep AtlasRAG behind your backend
- use Gunicorn + Nginx for the app
- store secrets in server-side env or a secret manager

That gives you the cleanest path to a real product on **AWS, Azure, or GCP**.
