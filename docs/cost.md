# SupaVector Cost Analysis

This document explains where cost comes from in SupaVector, how hosted and OSS differ, and why SupaVector is often cheaper than the traditional pattern of:

- generating on every lookup
- replaying the full conversation transcript every turn
- pasting large documents or code files into prompts again and again
- building your own memory, sync, dashboard, and tenancy surfaces around that workflow

## Important Scope

Hosted pricing in SupaVector is deployment-configured, not hard-coded in public docs. That means two things:

1. The billing model is stable.
2. The exact dollar rate can vary by deployment.

To make the math concrete, the worked examples below use the example values already used in the gateway billing tests:

| Example rate used in this document | Value |
| --- | ---: |
| AI generation | `$0.002 / 1K` billable generation tokens |
| Hosted storage | `$0.10 / GB-month` average retained storage |
| Included hosted storage | `0 GB-month` unless your deployment config says otherwise |

These are example numbers for analysis, not a claim about the live hosted rate on every deployment. Replace them with the rates shown in your Dashboard if you want exact live forecasting.

## Executive Summary

| Option | SupaVector software cost | Who pays generation cost | Who pays storage cost | Best cost profile |
| --- | --- | --- | --- | --- |
| OSS self-hosted bundled stack | `$0` | You and your provider | You and your infrastructure | Lowest cash outlay to SupaVector if you can run infra |
| OSS self-hosted with your own Postgres | `$0` | You and your provider | You and your infrastructure | Lowest platform cost with your own data boundary |
| Hosted API | No infra to run | Hosted credit by default, or your provider on matching BYO-key requests | Hosted retained `GB-month` | Lowest setup and ops cost |
| Hosted Agent Memory | Same hosted billing axes as Hosted API | Hosted credit or your provider on matching BYO-key generation | Hosted retained `GB-month` | Lowest total product+ops cost when you want UI, source sync, and Memory management |
| Traditional DIY stack | Usually no SupaVector bill, but you build everything | You and your provider | You and your infrastructure | Highest engineering and prompt-waste risk |

The shortest honest summary is:

- If you want the cheapest possible software line item and can run infrastructure, OSS self-hosting wins.
- If you want the cheapest total effort to ship, hosted usually wins.
- If you want a hosted control plane for sources, memory, Playground, and code-aware Memory workflows, Agent Memory is usually cheaper than building those surfaces yourself.

## What SupaVector Actually Bills For

### Hosted

| Meter | Trigger | Billing behavior |
| --- | --- | --- |
| AI generation | `ask`, `boolean_ask`, `code`, hosted Memory chat/code generation | Per 1,000 billable generation tokens |
| Storage | Retained hosted docs, memories, source sync artifacts, collections | Average retained `GB-month` |
| Search and retrieval-only flows | `search`, memory recall, indexing, most write/read operations | Not credit-gated for AI generation |

Notes:

- Hosted generation is the expensive meter when prompts get large.
- Hosted storage is usually the slow meter because it accrues over retained bytes, not per request.
- Matching BYO provider-key requests move generation billing to your provider, but storage still stays on the hosted deployment.

### OSS / Self-Hosted

| Meter | Trigger | Billing behavior |
| --- | --- | --- |
| SupaVector software | Any usage | `$0` to SupaVector |
| Your AI provider | Embeddings, ask, boolean ask, code, chat | Your provider bill |
| Your infrastructure | Postgres, gateway, storage, compute, network | Your infrastructure bill |

OSS is the clearest cash model:

- no hosted credit
- no hosted storage invoice
- no SupaVector platform fee
- you pay only for the infrastructure and providers you choose

## The Core Cost Formulas

### Hosted AI generation

```text
AI charge = (billable generation tokens / 1000) * AI rate per 1K
```

### Hosted storage

```text
Storage charge = average retained GB-month * storage rate per GB-month
```

### Useful break-even shortcut

At the example rates in this document:

```text
1 GB-month of retained hosted storage = 50,000 billable generation tokens
```

That single fact explains most of the economics:

- storing useful knowledge is often cheap
- repeatedly re-sending that same knowledge through generation is often expensive

## Why SupaVector Is Often Cheaper Than Traditional Prompt Stuffing

### 1. Search-first is cheaper than generate-everything

Many teams accidentally send every user lookup through a generation endpoint, even when the user only needed retrieval.

SupaVector lets you split the flow:

- `search` for retrieval-only UX
- `ask` or `code` only when synthesis is actually needed

That keeps generation spend proportional to real reasoning, not to every single lookup.

### 2. Memory-backed chat is cheaper than replaying the whole transcript

Traditional chat implementations often append the full conversation history to every new request. That makes cost grow roughly with conversation length.

SupaVector conversation memory keeps context bounded:

- recent turns are capped
- semantic recall is bounded by `semanticMemoryK`
- actor/profile and room context are reused instead of retyped

That means later turns do not pay the same exponential tax as naive transcript replay.

### 3. Index once, ask many times

Traditional workflows often:

- paste the same docs into prompts repeatedly
- paste the same code files into prompts repeatedly
- rebuild retrieval context client-side for every request

SupaVector stores the material once and reuses it across requests. In many real workloads, the storage cost of retaining the data is lower than the repeated generation cost of re-sending it.

### 4. Agent Memory reduces control-plane cost

Hosted Agent Memory does not only save runtime cost. It also saves build cost by giving you:

- source sync
- Memory configuration
- Playground/Test Agent
- chat memory behavior
- hosted code-aware flows
- token, project, and hosted Dashboard surfaces

Traditional stacks often rebuild those pieces around the model bill, which is where total system cost quietly grows.

## Worked Example 1: Stored Knowledge Is Usually Cheap

Using the example rates in this document:

| Retained hosted data | Monthly hosted storage cost | Generation-token equivalent |
| --- | ---: | ---: |
| `50 MB` | `$0.0049` | `~2.4K` billable generation tokens |
| `100 MB` | `$0.0098` | `~4.9K` billable generation tokens |
| `250 MB` | `$0.0244` | `~12.2K` billable generation tokens |
| `1 GB` | `$0.1000` | `50K` billable generation tokens |
| `5 GB` | `$0.5000` | `250K` billable generation tokens |

Interpretation:

- a moderately sized codebase or documentation corpus can be retained very cheaply
- the same knowledge can easily cost more if you keep shoving it into prompts over and over

## Worked Example 2: Search-First Beats Chat-First

Assume:

- `50,000` user lookups per month
- `500 MB` retained hosted knowledge
- each generated answer averages `1,200` billable generation tokens

### Scenario A: Traditional chat-first pattern

Every lookup generates an answer.

| Metric | Value |
| --- | ---: |
| Generation requests | `50,000` |
| Billable generation tokens | `60,000,000` |
| AI generation cost | `$120.00` |
| Hosted storage cost | `$0.0488` |
| Total | `$120.0488` |

### Scenario B: SupaVector retrieval-first pattern

Only `20%` of lookups need generation. The rest are retrieval-only.

| Metric | Value |
| --- | ---: |
| Retrieval-only searches | `40,000` |
| Generation requests | `10,000` |
| Billable generation tokens | `12,000,000` |
| AI generation cost | `$24.00` |
| Hosted storage cost | `$0.0488` |
| Total | `$24.0488` |

### Difference

| Comparison | Value |
| --- | ---: |
| AI generation savings | `$96.00 / month` |
| Total savings | `$96.00 / month` |
| Relative reduction | `~80%` |

This is one of the strongest economic arguments for SupaVector:

- not every retrieval event should become a generation event
- the platform makes it natural to keep those flows separate

## Worked Example 3: Agent Memory Memory vs Full Transcript Replay

Assume:

- `50` turns in one conversation
- average turn size: `150` tokens
- memory-backed chat keeps:
  - `6` recent turns
  - `4` semantic recall hits
  - average semantic hit size: `120` tokens

### Traditional full replay

Historic context tokens replayed across the session:

```text
150 * (0 + 1 + 2 + ... + 49) = 183,750 tokens
```

### SupaVector memory-backed chat

Bounded context per turn:

```text
(6 * 150) + (4 * 120) = 1,380 tokens
```

Across `50` turns:

```text
50 * 1,380 = 69,000 tokens
```

### Cost comparison

| Pattern | Historic context tokens replayed | Example generation cost |
| --- | ---: | ---: |
| Full transcript replay | `183,750` | `$0.3675` |
| Memory-backed bounded context | `69,000` | `$0.1380` |
| Savings | `114,750` | `$0.2295` |

### Why this matters

The longer the conversation gets, the better memory-backed chat tends to look:

- naive replay grows with conversation length
- bounded memory grows much more slowly

This is exactly why the `Remember` toggle in Agent Memory chat can be cheaper than dumping the entire transcript into every prompt.

## Worked Example 4: Code Mode vs Re-Pasting Code Into Chat

Assume:

- indexed repo size: `300 MB`
- `20` code investigations per month
- without indexing, each investigation pastes `8,000` extra prompt tokens of code context

### Traditional copy-paste approach

| Metric | Value |
| --- | ---: |
| Extra prompt tokens per investigation | `8,000` |
| Monthly investigations | `20` |
| Extra monthly generation tokens | `160,000` |
| Example generation cost | `$0.3200` |

### SupaVector code-aware approach

| Metric | Value |
| --- | ---: |
| Retained repo size | `300 MB` |
| Monthly hosted storage cost | `$0.0293` |
| Generation-token equivalent | `~14.6K` tokens |

### Interpretation

At the example rates:

- a retained `300 MB` codebase costs about `$0.0293 / month`
- that is equivalent to only about `14.6K` billable generation tokens

So if indexing the repo avoids even a small amount of repeated code pasting, the storage cost is already justified. That is before counting:

- better retrieval precision
- better code structure understanding
- less manual prompt assembly
- lower latency for humans trying to debug or review code

## Worked Example 5: OSS vs Hosted vs Agent Memory

| Model | SupaVector platform bill | Generation bill | Storage bill | Ops cost | Engineering cost | Best use case |
| --- | --- | --- | --- | --- | --- | --- |
| OSS self-hosted | `$0` | Your provider | Your infra | Highest | Medium | Teams that want the lowest recurring software spend and can run infra |
| Hosted API | Hosted usage only | Hosted credit or your provider | Hosted retained `GB-month` | Very low | Low | Teams that want to ship fastest without running SupaVector |
| Hosted Agent Memory | Same hosted usage axes as Hosted API | Hosted credit or your provider | Hosted retained `GB-month` | Very low | Lowest | Teams that want hosted source sync, Memory config, Playground, and code-aware workflows |
| Traditional DIY stack | No SupaVector bill | Your provider | Your infra | High | Highest | Teams willing to build their own retrieval, memory, sync, and control plane |

The key point is not that hosted is always cheaper than self-hosting. It is not.

The key point is:

- OSS self-hosting is usually the cheapest pure software path
- hosted is usually the cheapest total delivery path
- Agent Memory is usually the cheapest path when you also value the hosted Memory workflow and do not want to build that surface area yourself

## Traditional Cost Traps SupaVector Avoids

| Traditional pattern | Why it becomes expensive | SupaVector alternative | Why the alternative is cheaper |
| --- | --- | --- | --- |
| Generate on every lookup | Every request becomes a token event | Use `search` for retrieval-only flows | Most retrieval requests stop consuming generation budget |
| Replay full chat history | Prompt size grows every turn | Use memory-backed chat / Agent Memory `Remember` | Context stays bounded instead of growing linearly forever |
| Paste large docs repeatedly | The same information is paid for many times | Index once, retrieve many times | Storage is often cheaper than repeated prompt inflation |
| Paste code repeatedly | Code prompts get large fast | Use `code` on indexed repos and code documents | Indexed retrieval is usually cheaper and more precise |
| Build your own source sync | More engineering and more failure modes | Use hosted Memory sources or CLI ingest | Lowers ops and maintenance cost |
| Build your own memory UI and admin surface | Hidden product cost, not just model cost | Use Hosted Agent Memory / Dashboard | Cuts engineering time and support burden |

## Choosing The Most Affordable Path

### Pick OSS self-hosted when

- you want the lowest recurring cash outlay to SupaVector
- you already run containers, Postgres, secrets, and provider keys
- your team is comfortable owning uptime, upgrades, and backups

### Pick Hosted API when

- you want the lowest time-to-first-request
- you do not want Docker, Postgres, or server operations
- you want hosted storage plus the option to move generation to BYO provider keys later

### Pick Hosted Agent Memory when

- you want hosted source sync, Memory config, Playground/Test Agent, and managed knowledge workflows
- you want to test chat, boolean ask, and code against the same Memory
- you want a cheaper total product cost than building those surfaces yourself

## Practical Rules To Keep Cost Low

1. Use `search` when you only need retrieval.
2. Use `ask`, `boolean_ask`, or `code` only when the request actually needs synthesis.
3. Turn conversation memory on for longer sessions instead of replaying the whole transcript.
4. Index documents and code once instead of pasting them repeatedly.
5. On hosted deployments, use matching BYO provider-key headers when that billing model is better for your workload.
6. If your volume is sustained and your team can run infrastructure, move to OSS self-hosting.

## Bottom Line

SupaVector is affordable for three different reasons depending on the path:

| Path | Why it is affordable |
| --- | --- |
| OSS | The SupaVector software itself costs `$0`; you only pay your own provider and infrastructure |
| Hosted API | You do not pay the ops tax of running SupaVector yourself, and you can keep many flows retrieval-first instead of generation-first |
| Hosted Agent Memory | You get the hosted runtime plus the Memory UI, source sync, Playground, and memory/code workflow without building those layers yourself |

Compared with the traditional approach, the biggest savings usually come from:

- fewer unnecessary generation calls
- fewer repeated prompt tokens
- cheaper retained knowledge than repeated reprompting
- lower engineering and maintenance cost around the memory layer

## Related Guides

- [`setup-modes.md`](setup-modes.md)
- [`hosted.md`](hosted.md)
- [`agents.md`](agents.md)
- [`self-hosting.md`](self-hosting.md)
- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
