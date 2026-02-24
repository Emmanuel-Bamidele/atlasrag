#!/usr/bin/env python3
"""Compute per-run metrics from telemetry NDJSON and write submission artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize a single experiment run")
    parser.add_argument("--input", required=True, help="Path to raw_logs.ndjson")
    parser.add_argument("--output-dir", required=True, help="Run output directory")
    parser.add_argument("--run-id", required=False, default="", help="Optional run_id filter")
    parser.add_argument("--policy", required=True)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--config-id", required=True)
    parser.add_argument("--config-file", required=True)
    parser.add_argument("--ablation-group", default="")
    parser.add_argument("--ablation-value", default="")
    parser.add_argument("--suite-id", default="")
    return parser.parse_args()


def pct(values: List[float], p: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    rank = int(math.ceil((p / 100.0) * len(ordered)) - 1)
    rank = min(len(ordered) - 1, max(0, rank))
    return float(ordered[rank])


def mean(values: List[float]) -> Optional[float]:
    if not values:
        return None
    return float(sum(values) / len(values))


def classify_endpoint(path_value: str) -> str:
    clean = (path_value or "").split("?", 1)[0]
    if clean in {"/memory", "/memory/write", "/v1/memory", "/v1/memory/write"}:
        return "write"
    if clean in {"/memory/recall", "/v1/memory/recall"}:
        return "recall"
    if clean in {"/ask", "/v1/ask"}:
        return "ask"
    return "other"


def normalize_tier_count(dist: Any, keys: Iterable[str]) -> int:
    if not isinstance(dist, dict):
        return 0
    total = 0
    for key in keys:
        value = dist.get(key)
        if isinstance(value, (int, float)):
            total += int(value)
    return int(total)


def write_csv(path: Path, rows: List[Dict[str, Any]], headers: List[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in headers})


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise FileNotFoundError(f"input file not found: {input_path}")

    events: List[Dict[str, Any]] = []
    with input_path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            raw = line.strip()
            if not raw:
                continue
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON line {line_no} in {input_path}: {exc}") from exc
            if args.run_id and str(ev.get("run_id", "")) != args.run_id:
                continue
            events.append(ev)

    latencies: List[float] = []
    endpoint_latencies: Dict[str, List[float]] = {"write": [], "recall": [], "ask": []}
    request_rows: List[Dict[str, Any]] = []
    success_count = 0

    candidate_sizes: List[float] = []
    vectors_scanned: List[float] = []
    candidates_rows: List[Dict[str, Any]] = []

    prompt_tokens: List[float] = []
    prompt_rows: List[Dict[str, Any]] = []

    snapshot_rows: List[Dict[str, Any]] = []
    starts: List[int] = []
    ends: List[int] = []

    for ev in events:
        et = str(ev.get("event_type", ""))
        ts_ms = ev.get("timestamp_ms")
        if isinstance(ts_ms, (int, float)):
            ts_ms = int(ts_ms)
        else:
            ts_ms = None

        if et == "request_finish":
            path = str(ev.get("path", "")).split("?", 1)[0]
            if path in {"/health", "/v1/health"}:
                continue
            latency = ev.get("latency_ms")
            if not isinstance(latency, (int, float)):
                continue
            latency = float(latency)
            endpoint = str(ev.get("endpoint") or classify_endpoint(path))
            status = int(ev.get("status") or 0)
            success = bool(ev.get("success")) if "success" in ev else (200 <= status < 300)
            start_ts_ms = ev.get("start_ts_ms")
            end_ts_ms = ev.get("end_ts_ms")
            if not isinstance(start_ts_ms, (int, float)):
                start_ts_ms = (ts_ms - int(latency)) if ts_ms is not None else None
            if not isinstance(end_ts_ms, (int, float)):
                end_ts_ms = ts_ms
            if isinstance(start_ts_ms, (int, float)):
                starts.append(int(start_ts_ms))
            if isinstance(end_ts_ms, (int, float)):
                ends.append(int(end_ts_ms))

            latencies.append(latency)
            if endpoint in endpoint_latencies:
                endpoint_latencies[endpoint].append(latency)
            if success:
                success_count += 1
            request_rows.append(
                {
                    "timestamp_ms": ts_ms,
                    "start_ts_ms": int(start_ts_ms) if isinstance(start_ts_ms, (int, float)) else "",
                    "end_ts_ms": int(end_ts_ms) if isinstance(end_ts_ms, (int, float)) else "",
                    "path": path,
                    "endpoint": endpoint,
                    "status": status,
                    "success": int(success),
                    "latency_ms": latency,
                }
            )

        elif et == "memory_candidates":
            r = ev.get("candidate_set_size_R", ev.get("retrieval_set_size"))
            v = ev.get("vectors_scanned", ev.get("vector_search_scanned_count"))
            h = ev.get("hot_count", 0)
            w = ev.get("warm_count", ev.get("warm_sampled", 0))
            c = ev.get("cold_count", ev.get("cold_candidates", 0))
            rb = ev.get("retrieval_bound")

            r_val = float(r) if isinstance(r, (int, float)) else None
            v_val = float(v) if isinstance(v, (int, float)) else None
            if r_val is not None:
                candidate_sizes.append(r_val)
            if v_val is not None:
                vectors_scanned.append(v_val)

            candidates_rows.append(
                {
                    "timestamp_ms": ts_ms if ts_ms is not None else "",
                    "candidate_set_size_R": r_val if r_val is not None else "",
                    "vectors_scanned": v_val if v_val is not None else "",
                    "hot_count": int(h) if isinstance(h, (int, float)) else 0,
                    "warm_count": int(w) if isinstance(w, (int, float)) else 0,
                    "cold_count": int(c) if isinstance(c, (int, float)) else 0,
                    "retrieval_bound": int(rb) if isinstance(rb, (int, float)) else "",
                }
            )

        elif et == "prompt_constructed":
            tok = ev.get("prompt_tokens", ev.get("prompt_tokens_est", ev.get("total_tokens_est")))
            total_tok = ev.get("total_tokens_est", tok)
            injected = ev.get("injected_chunks_count", ev.get("chunk_count", 0))
            if isinstance(tok, (int, float)):
                prompt_tokens.append(float(tok))
            prompt_rows.append(
                {
                    "timestamp_ms": ts_ms if ts_ms is not None else "",
                    "prompt_tokens": float(tok) if isinstance(tok, (int, float)) else "",
                    "total_tokens_est": float(total_tok) if isinstance(total_tok, (int, float)) else "",
                    "injected_chunks_count": int(injected) if isinstance(injected, (int, float)) else 0,
                }
            )

        elif et == "memory_snapshot":
            tier = ev.get("tier_distribution") if isinstance(ev.get("tier_distribution"), dict) else {}
            hot_count = normalize_tier_count(tier, ["HOT", "hot", "Hot"])
            warm_count = normalize_tier_count(tier, ["WARM", "warm", "Warm"])
            cold_count = normalize_tier_count(tier, ["COLD", "cold", "Cold"])
            total_items = ev.get("total_items")
            snapshot_rows.append(
                {
                    "timestamp_ms": ts_ms if ts_ms is not None else "",
                    "total_items": int(total_items) if isinstance(total_items, (int, float)) else "",
                    "hot_count": hot_count,
                    "warm_count": warm_count,
                    "cold_count": cold_count,
                }
            )

    total_requests = len(latencies)
    duration_sec = None
    if starts and ends:
        span_ms = max(ends) - min(starts)
        if span_ms > 0:
            duration_sec = span_ms / 1000.0
    throughput = (total_requests / duration_sec) if (duration_sec and duration_sec > 0) else None

    summary: Dict[str, Any] = {
        "suite_id": args.suite_id,
        "run_id": args.run_id,
        "policy": args.policy,
        "scenario": args.scenario,
        "seed": args.seed,
        "config_id": args.config_id,
        "config_file": args.config_file,
        "ablation_group": args.ablation_group,
        "ablation_value": args.ablation_value,
        "request_count": total_requests,
        "latency_ms": {
            "p50": pct(latencies, 50),
            "p95": pct(latencies, 95),
            "p99": pct(latencies, 99),
        },
        "throughput_req_per_s": throughput,
        "fraction_gt_1s": (sum(1 for v in latencies if v > 1000.0) / total_requests) if total_requests else None,
        "fraction_gt_2s": (sum(1 for v in latencies if v > 2000.0) / total_requests) if total_requests else None,
        "success_rate": (success_count / total_requests) if total_requests else None,
        "candidate_set_size": {
            "p95": pct(candidate_sizes, 95),
            "mean": mean(candidate_sizes),
        },
        "vectors_scanned": {
            "p95": pct(vectors_scanned, 95),
            "mean": mean(vectors_scanned),
        },
        "prompt_tokens": {
            "mean": mean(prompt_tokens),
            "p95": pct(prompt_tokens, 95),
        },
        "endpoint_latency_ms": {
            "write_p95": pct(endpoint_latencies["write"], 95),
            "recall_p95": pct(endpoint_latencies["recall"], 95),
            "ask_p95": pct(endpoint_latencies["ask"], 95),
        },
    }

    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    result_row = {
        "suite_id": args.suite_id,
        "run_id": args.run_id,
        "policy": args.policy,
        "scenario": args.scenario,
        "seed": args.seed,
        "config_id": args.config_id,
        "config_file": args.config_file,
        "ablation_group": args.ablation_group,
        "ablation_value": args.ablation_value,
        "request_count": total_requests,
        "latency_p50_ms": summary["latency_ms"]["p50"],
        "latency_p95_ms": summary["latency_ms"]["p95"],
        "latency_p99_ms": summary["latency_ms"]["p99"],
        "throughput_req_per_s": summary["throughput_req_per_s"],
        "fraction_gt_1s": summary["fraction_gt_1s"],
        "fraction_gt_2s": summary["fraction_gt_2s"],
        "success_rate": summary["success_rate"],
        "candidate_set_p95": summary["candidate_set_size"]["p95"],
        "vectors_scanned_p95": summary["vectors_scanned"]["p95"],
        "vectors_scanned_mean": summary["vectors_scanned"]["mean"],
        "prompt_tokens_mean": summary["prompt_tokens"]["mean"],
        "prompt_tokens_p95": summary["prompt_tokens"]["p95"],
        "write_latency_p95_ms": summary["endpoint_latency_ms"]["write_p95"],
        "recall_latency_p95_ms": summary["endpoint_latency_ms"]["recall_p95"],
        "ask_latency_p95_ms": summary["endpoint_latency_ms"]["ask_p95"],
    }

    result_headers = list(result_row.keys())
    write_csv(out_dir / "results.csv", [result_row], result_headers)

    write_csv(
        out_dir / "request_latencies.csv",
        request_rows,
        ["timestamp_ms", "start_ts_ms", "end_ts_ms", "path", "endpoint", "status", "success", "latency_ms"],
    )
    write_csv(
        out_dir / "memory_candidates.csv",
        candidates_rows,
        ["timestamp_ms", "candidate_set_size_R", "vectors_scanned", "hot_count", "warm_count", "cold_count", "retrieval_bound"],
    )
    write_csv(
        out_dir / "prompt_tokens.csv",
        prompt_rows,
        ["timestamp_ms", "prompt_tokens", "total_tokens_est", "injected_chunks_count"],
    )
    write_csv(
        out_dir / "memory_snapshot_counts.csv",
        snapshot_rows,
        ["timestamp_ms", "total_items", "hot_count", "warm_count", "cold_count"],
    )


if __name__ == "__main__":
    main()
