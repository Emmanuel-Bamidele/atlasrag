#!/usr/bin/env python3
"""Run AtlasRAG submission experiment suite (baseline + stress + ablations)."""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[2]
EXPERIMENTS_DIR = ROOT / "experiments"
CONFIG_DIR = EXPERIMENTS_DIR / "configs"
DEFAULT_RUNS_ROOT = ROOT / "telemetry" / "experiments_runs"
DEFAULT_ARTIFACTS_ROOT = ROOT / "telemetry" / "experiments_artifacts"
DEFAULT_TELEMETRY_ROOT = ROOT / "telemetry" / "experiments_event_logs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run submission-quality AtlasRAG experiment suite")
    parser.add_argument("--suite", choices=["full", "baseline", "stress", "ablation"], default="full")
    parser.add_argument("--seeds", default="1337,2027,3037")
    parser.add_argument("--base-env", default=str(ROOT / ".env"))
    parser.add_argument("--compose-file", default=str(ROOT / "docker-compose.yml"))
    parser.add_argument("--compose-project-prefix", default="atlasrag_exp")
    parser.add_argument("--docker-bin", default="/usr/local/bin/docker")
    parser.add_argument("--username", default=os.environ.get("EVAL_USERNAME", "ci_admin"))
    parser.add_argument("--password", default=os.environ.get("EVAL_PASSWORD", "ci_admin_password"))
    parser.add_argument("--collection-prefix", default="submission_suite")
    parser.add_argument("--tag", default="submission_suite")
    parser.add_argument("--quick", action="store_true", help="Smoke mode: scale workload counts down")
    parser.add_argument("--max-runs", type=int, default=0)
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--skip-analysis", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--request-timeout-ms", type=int, default=120000)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument(
        "--workload-concurrency",
        type=int,
        default=0,
        help="Override workload concurrency for all runs (0 keeps config defaults).",
    )
    parser.add_argument("--runs-root", default=str(DEFAULT_RUNS_ROOT))
    parser.add_argument("--artifacts-root", default=str(DEFAULT_ARTIFACTS_ROOT))
    parser.add_argument("--telemetry-root", default=str(DEFAULT_TELEMETRY_ROOT))
    parser.add_argument(
        "--resume-suite-dir",
        default="",
        help="Resume an existing suite directory in place (skips completed run stems).",
    )
    parser.add_argument(
        "--resume-skip-failed",
        action="store_true",
        help="When resuming, keep previously failed run stems as-is instead of rerunning them.",
    )
    return parser.parse_args()


def now_utc_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def timestamp_slug() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")


def run_cmd(cmd: List[str], cwd: Path, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        text=True,
        capture_output=capture,
        check=True,
    )


def safe_name(value: str) -> str:
    out = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value.strip().lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or "run"


def unique_suite_dir(tag: str, runs_root: Path) -> Tuple[str, Path]:
    runs_root.mkdir(parents=True, exist_ok=True)
    base = f"{timestamp_slug()}_{safe_name(tag)}"
    suite_id = base
    suite_dir = runs_root / suite_id
    idx = 1
    while suite_dir.exists():
        suite_id = f"{base}_{idx}"
        suite_dir = runs_root / suite_id
        idx += 1
    suite_dir.mkdir(parents=True, exist_ok=False)
    return suite_id, suite_dir


def ensure_docker_bin(path_value: str) -> str:
    candidate = Path(path_value)
    if candidate.exists() and os.access(candidate, os.X_OK):
        return str(candidate)
    found = shutil.which("docker")
    if found:
        return found
    raise FileNotFoundError("docker executable not found")


def ensure_docker_daemon_running(docker_bin: str) -> None:
    probe = subprocess.run(
        [docker_bin, "info"],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
    )
    if probe.returncode == 0:
        return

    detail = (probe.stderr or probe.stdout or "").strip()
    message = [
        "Docker daemon is not reachable.",
        "Start Docker Desktop (or the Docker daemon), wait until it is healthy, then rerun the suite.",
        "Quick check: `docker info` should return successfully.",
    ]
    if detail:
        message.append(f"docker info output: {detail}")
    raise RuntimeError("\n".join(message))


def parse_seed_list(raw: str) -> List[int]:
    out: List[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(int(part))
    if not out:
        raise ValueError("at least one seed is required")
    return out


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_all_configs() -> Dict[str, Any]:
    policies = {
        "TTL": load_json(CONFIG_DIR / "policies" / "ttl_baseline.json"),
        "LRU": load_json(CONFIG_DIR / "policies" / "lru_baseline.json"),
        "AMV-L": load_json(CONFIG_DIR / "policies" / "amvl_default.json"),
    }
    stress = {
        "phase_shift": load_json(CONFIG_DIR / "stress" / "phase_shift.json"),
        "bursty_write": load_json(CONFIG_DIR / "stress" / "bursty_write.json"),
        "aged_recall": load_json(CONFIG_DIR / "stress" / "aged_recall.json"),
    }
    ablations: List[Dict[str, Any]] = []
    for group in ["lambda", "k", "alpha_beta"]:
        group_dir = CONFIG_DIR / "ablations" / group
        for path in sorted(group_dir.glob("*.json")):
            cfg = load_json(path)
            cfg["_path"] = str(path)
            ablations.append(cfg)
    return {
        "policies": policies,
        "stress": stress,
        "ablations": ablations,
    }


def scale_count(value: Any, quick: bool, minimum: int = 1) -> int:
    count = int(value)
    if not quick:
        return count
    scaled = int(round(count * 0.04))
    return max(minimum, scaled)


def scaled_workload(base: Dict[str, Any], quick: bool) -> Dict[str, Any]:
    out = dict(base)
    if not quick:
        return out
    for key in ["writes", "min_asks", "recall_k", "ask_k", "snapshot_every", "log_every"]:
        if key not in out:
            continue
        if key in {"recall_k", "ask_k"}:
            out[key] = max(4, int(out[key]))
        elif key == "snapshot_every":
            out[key] = max(50, scale_count(out[key], quick, minimum=10))
        elif key == "log_every":
            out[key] = max(50, scale_count(out[key], quick, minimum=10))
        else:
            out[key] = scale_count(out[key], quick, minimum=50)
    out["concurrency"] = min(8, int(out.get("concurrency", 1)))
    return out


def scaled_scenario(cfg: Dict[str, Any], quick: bool) -> Dict[str, Any]:
    if not quick:
        return cfg
    scaled = json.loads(json.dumps(cfg))
    if "phases" in scaled and isinstance(scaled["phases"], list):
        for phase in scaled["phases"]:
            for key in ["writes", "recalls", "asks"]:
                if key in phase:
                    phase[key] = scale_count(phase[key], quick, minimum=20)
    for block in ["early_facts", "background", "probes"]:
        if block in scaled and isinstance(scaled[block], dict):
            for key in ["writes", "recalls", "asks"]:
                if key in scaled[block]:
                    scaled[block][key] = scale_count(scaled[block][key], quick, minimum=20)
    if "workload" in scaled and isinstance(scaled["workload"], dict):
        scaled["workload"]["concurrency"] = min(8, int(scaled["workload"].get("concurrency", 1)))
        scaled["workload"]["log_every"] = max(50, scale_count(scaled["workload"].get("log_every", 250), quick, minimum=10))
    return scaled


def get_git_commit() -> str:
    result = run_cmd(["git", "rev-parse", "HEAD"], cwd=ROOT, capture=True)
    return result.stdout.strip()


def get_machine_info() -> Dict[str, Any]:
    memory_bytes = None
    if hasattr(os, "sysconf"):
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            if isinstance(pages, int) and isinstance(page_size, int):
                memory_bytes = int(pages * page_size)
        except Exception:
            memory_bytes = None
    return {
        "platform": platform.platform(),
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "memory_bytes": memory_bytes,
    }


def build_suite_runs(args: argparse.Namespace, cfg: Dict[str, Any], seeds: List[int]) -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []
    policy_config_paths = {
        "TTL": str(CONFIG_DIR / "policies" / "ttl_baseline.json"),
        "LRU": str(CONFIG_DIR / "policies" / "lru_baseline.json"),
        "AMV-L": str(CONFIG_DIR / "policies" / "amvl_default.json"),
    }

    include_baseline = args.suite in {"full", "baseline"}
    include_stress = args.suite in {"full", "stress"}
    include_ablation = args.suite in {"full", "ablation"}

    if include_baseline:
        for seed in seeds:
            for policy in ["TTL", "LRU", "AMV-L"]:
                policy_cfg = cfg["policies"][policy]
                runs.append(
                    {
                        "scenario": "baseline",
                        "policy": policy,
                        "seed": seed,
                        "config_id": policy_cfg["id"],
                        "policy_config": policy_cfg,
                        "policy_config_path": policy_config_paths[policy],
                        "ablation_group": "",
                        "ablation_value": "",
                        "scenario_config": None,
                        "scenario_config_path": "",
                        "workload_kind": "seeded",
                    }
                )

    if include_stress:
        for seed in seeds:
            for scenario in ["phase_shift", "bursty_write", "aged_recall"]:
                scenario_cfg = cfg["stress"][scenario]
                for policy in ["TTL", "LRU", "AMV-L"]:
                    policy_cfg = cfg["policies"][policy]
                    runs.append(
                        {
                            "scenario": scenario,
                            "policy": policy,
                            "seed": seed,
                            "config_id": f"{scenario_cfg['id']}__{policy_cfg['id']}",
                            "policy_config": policy_cfg,
                            "policy_config_path": policy_config_paths[policy],
                            "ablation_group": "",
                            "ablation_value": "",
                            "scenario_config": scenario_cfg,
                            "scenario_config_path": str(CONFIG_DIR / "stress" / f"{scenario}.json"),
                            "workload_kind": "scenario",
                        }
                    )

    if include_ablation:
        for seed in seeds:
            for ablation_cfg in cfg["ablations"]:
                policy_cfg = cfg["policies"]["AMV-L"]
                group = str(ablation_cfg.get("group", ""))
                value = ""
                env_map = ablation_cfg.get("env", {})
                if group == "lambda":
                    value = str(env_map.get("MEMORY_VALUE_DECAY_LAMBDA", ""))
                elif group == "k":
                    value = str(env_map.get("MEMORY_RETRIEVAL_WARM_SAMPLE_K", ""))
                elif group == "alpha_beta":
                    value = f"alpha={env_map.get('MEMORY_ACCESS_ALPHA', '')}|beta={env_map.get('MEMORY_CONTRIBUTION_BETA', '')}"
                runs.append(
                    {
                        "scenario": "ablation",
                        "policy": "AMV-L",
                        "seed": seed,
                        "config_id": ablation_cfg.get("id", "ablation"),
                        "policy_config": policy_cfg,
                        "policy_config_path": str(CONFIG_DIR / "policies" / "amvl_default.json"),
                        "ablation_group": group,
                        "ablation_value": value,
                        "ablation_config": ablation_cfg,
                        "ablation_config_path": ablation_cfg.get("_path", ""),
                        "scenario_config": None,
                        "scenario_config_path": "",
                        "workload_kind": "seeded",
                    }
                )

    if args.max_runs and args.max_runs > 0:
        runs = runs[: args.max_runs]

    return runs


def run_stem_for(run_spec: Dict[str, Any], idx: int) -> str:
    return safe_name(f"{run_spec['policy']}__{run_spec['scenario']}__seed{int(run_spec['seed'])}__{idx:03d}")


def default_compose_ports_for_suite(suite_id: str) -> Dict[str, int]:
    suite_hash = sum(ord(ch) for ch in suite_id) % 1000
    return {
        "gateway": 13000 + suite_hash,
        "postgres": 23000 + suite_hash,
    }


def parse_compose_ports(value: Any, suite_id: str) -> Dict[str, int]:
    if isinstance(value, dict):
        try:
            gateway = int(value.get("gateway"))
            postgres = int(value.get("postgres"))
            return {"gateway": gateway, "postgres": postgres}
        except Exception:
            pass
    return default_compose_ports_for_suite(suite_id)


def read_json_if_exists(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def existing_index_by_stem(suite_dir: Path) -> Dict[str, Dict[str, Any]]:
    index_path = suite_dir / "runs_index.json"
    if not index_path.exists():
        return {}
    try:
        rows = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    by_stem: Dict[str, Dict[str, Any]] = {}
    if not isinstance(rows, list):
        return by_stem
    for row in rows:
        if not isinstance(row, dict):
            continue
        run_dir = Path(str(row.get("run_dir", "")))
        stem = run_dir.name
        if stem:
            by_stem[stem] = row
    return by_stem


def result_from_manifest(run_dir: Path, run_spec: Dict[str, Any], fallback_status: str = "unknown") -> Dict[str, Any]:
    manifest = read_json_if_exists(run_dir / "run_manifest.json")
    return {
        "run_id": str(manifest.get("run_id", "")),
        "run_dir": str(run_dir),
        "policy": str(manifest.get("policy", run_spec.get("policy", ""))),
        "scenario": str(manifest.get("scenario", run_spec.get("scenario", ""))),
        "seed": int(manifest.get("seed", int(run_spec.get("seed", 0) or 0))),
        "status": str(manifest.get("status", fallback_status)),
        "config_id": str(manifest.get("config_id", run_spec.get("config_id", ""))),
        "ablation_group": str(manifest.get("ablation_group", run_spec.get("ablation_group", ""))),
        "ablation_value": str(manifest.get("ablation_value", run_spec.get("ablation_value", ""))),
    }


def next_retry_stem(base_stem: str, suite_dir: Path) -> str:
    retry_idx = 1
    while True:
        candidate = f"{base_stem}_retry{retry_idx:02d}"
        if not (suite_dir / candidate).exists():
            return candidate
        retry_idx += 1


def completed_retry_result(base_stem: str, suite_dir: Path, run_spec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    prefix = f"{base_stem}_retry"
    latest: Optional[Dict[str, Any]] = None
    for candidate in sorted(suite_dir.iterdir(), key=lambda p: p.name):
        if not candidate.is_dir():
            continue
        if not candidate.name.startswith(prefix):
            continue
        result = result_from_manifest(candidate, run_spec)
        if str(result.get("status", "")).lower() in {"completed", "dry_run"}:
            latest = result
    return latest


def wait_for_redis_ready(compose_base: List[str]) -> None:
    probe = (
        "const net=require('net');"
        "const s=net.connect({host:'redis',port:6379},()=>{console.log('ready');s.end();process.exit(0)});"
        "s.on('error',()=>process.exit(1));"
        "setTimeout(()=>process.exit(2),1200);"
    )
    attempts = 120
    for i in range(1, attempts + 1):
        try:
            proc = subprocess.run(
                compose_base + ["exec", "-T", "gateway", "node", "-e", probe],
                cwd=str(ROOT),
                text=True,
                timeout=15,
                capture_output=True,
            )
        except subprocess.TimeoutExpired:
            time.sleep(2)
            continue
        if proc.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError("redis readiness check failed")


def wait_for_postgres_ready(compose_base: List[str]) -> None:
    probe = (
        "const { Pool } = require('pg');"
        "(async()=>{"
        "const pool = new Pool();"
        "try {"
        "await pool.query('SELECT 1');"
        "console.log('ready');"
        "process.exit(0);"
        "} catch (e) {"
        "console.error(e && e.message ? e.message : e);"
        "process.exit(1);"
        "} finally {"
        "await pool.end().catch(()=>{});"
        "}"
        "})();"
    )
    attempts = 120
    for _ in range(1, attempts + 1):
        try:
            proc = subprocess.run(
                compose_base + ["exec", "-T", "gateway", "node", "-e", probe],
                cwd=str(ROOT),
                text=True,
                timeout=20,
                capture_output=True,
            )
        except subprocess.TimeoutExpired:
            time.sleep(2)
            continue
        if proc.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError("postgres readiness check failed")


def write_env_file(base_env_path: Path, target_path: Path, env_overrides: Dict[str, str]) -> None:
    base_text = base_env_path.read_text(encoding="utf-8")
    lines = [base_text.rstrip(), "", "# --- experiment overrides ---"]
    for key in sorted(env_overrides.keys()):
        lines.append(f"{key}={env_overrides[key]}")
    target_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_single(
    idx: int,
    total: int,
    run_spec: Dict[str, Any],
    args: argparse.Namespace,
    suite_id: str,
    suite_dir: Path,
    telemetry_suite_dir: Path,
    docker_bin: str,
    compose_project: str,
    compose_ports: Dict[str, int],
    git_commit: str,
    machine_info: Dict[str, Any],
    run_stem_override: str = "",
) -> Dict[str, Any]:
    scenario = run_spec["scenario"]
    policy = run_spec["policy"]
    seed = int(run_spec["seed"])

    run_stem = safe_name(run_stem_override) if run_stem_override else safe_name(f"{policy}__{scenario}__seed{seed}__{idx:03d}")
    run_id = f"{run_stem}-{timestamp_slug()}"
    run_dir = suite_dir / run_stem
    run_dir.mkdir(parents=True, exist_ok=False)

    telemetry_rel = Path("experiments") / suite_id / f"{run_id}.ndjson"
    telemetry_host = ROOT / "telemetry" / telemetry_rel
    telemetry_host.parent.mkdir(parents=True, exist_ok=True)

    policy_cfg = run_spec["policy_config"]
    policy_env = {str(k): str(v) for k, v in (policy_cfg.get("env") or {}).items()}

    env_overrides: Dict[str, str] = {
        "OPENAI_API_KEY": "",
        "EMBED_FALLBACK_ON_ERROR": "1",
        "OPENAI_TIMEOUT_MS": "30000",
        "RATE_LIMIT_WINDOW_MS": "60000",
        "RATE_LIMIT_MAX": "1000000",
        "TENANT_RATE_LIMIT_WINDOW_MS": "60000",
        "TENANT_RATE_LIMIT_MAX": "1000000",
        "TELEMETRY_ENABLED": "1",
        "TELEMETRY_CONFIG_ID": run_spec["config_id"],
        "TELEMETRY_RUN_ID": run_id,
        "TELEMETRY_POLICY": policy,
        "TELEMETRY_FILE": f"/app/telemetry/{telemetry_rel.as_posix()}",
        "TELEMETRY_SNAPSHOT_INTERVAL_MS": "5000",
        "MEMORY_RETRIEVAL_COLD_PROBE_EPSILON": "0",
        "POSTGRES_HOST_PORT": str(int(compose_ports["postgres"])),
        "GATEWAY_HOST_PORT": str(int(compose_ports["gateway"])),
    }
    env_overrides.update(policy_env)

    if run_spec.get("ablation_config"):
        env_overrides.update({str(k): str(v) for k, v in (run_spec["ablation_config"].get("env") or {}).items()})

    env_file = run_dir / "compose.env"
    write_env_file(Path(args.base_env), env_file, env_overrides)

    run_meta = {
        "suite_id": suite_id,
        "run_id": run_id,
        "index": idx,
        "total_runs": total,
        "started_at": now_utc_iso(),
        "policy": policy,
        "scenario": scenario,
        "seed": seed,
        "config_id": run_spec["config_id"],
        "config_file": run_spec.get("policy_config_path", ""),
        "scenario_config_file": run_spec.get("scenario_config_path", ""),
        "ablation_config_file": run_spec.get("ablation_config_path", ""),
        "ablation_group": run_spec.get("ablation_group", ""),
        "ablation_value": run_spec.get("ablation_value", ""),
        "git_commit": git_commit,
        "machine_info": machine_info,
        "env_file": str(env_file),
        "telemetry_host_file": str(telemetry_host),
        "dry_run": bool(args.dry_run),
        "quick_mode": bool(args.quick),
    }
    (run_dir / "run_manifest.json").write_text(json.dumps(run_meta, indent=2), encoding="utf-8")

    collection = f"{safe_name(args.collection_prefix)}_{safe_name(scenario)}_{safe_name(policy)}_{seed}"
    compose_base = [
        docker_bin,
        "compose",
        "-p",
        compose_project,
        "-f",
        str(Path(args.compose_file)),
        "--env-file",
        str(env_file),
    ]

    workload = scaled_workload(policy_cfg.get("workload") or {}, args.quick)
    if args.workload_concurrency and args.workload_concurrency > 0:
        workload["concurrency"] = int(args.workload_concurrency)
    if run_spec["workload_kind"] == "scenario":
        scenario_cfg = scaled_scenario(run_spec["scenario_config"], args.quick)
        if args.workload_concurrency and args.workload_concurrency > 0:
            scenario_cfg.setdefault("workload", {})
            scenario_cfg["workload"]["concurrency"] = int(args.workload_concurrency)
    else:
        scenario_cfg = None

    if args.dry_run:
        run_meta["status"] = "dry_run"
        run_meta["ended_at"] = now_utc_iso()
        (run_dir / "run_manifest.json").write_text(json.dumps(run_meta, indent=2), encoding="utf-8")
        return {
            "run_id": run_id,
            "run_dir": str(run_dir),
            "policy": policy,
            "scenario": scenario,
            "seed": seed,
            "status": "dry_run",
            "config_id": run_spec["config_id"],
            "ablation_group": run_spec.get("ablation_group", ""),
            "ablation_value": run_spec.get("ablation_value", ""),
        }

    try:
        run_cmd(
            compose_base + ["up", "-d", "--build", "--force-recreate", "redis", "postgres", "gateway"],
            cwd=ROOT,
        )
        wait_for_redis_ready(compose_base)
        wait_for_postgres_ready(compose_base)

        run_cmd(
            compose_base
            + [
                "exec",
                "-T",
                "gateway",
                "node",
                "scripts/ensure_user.js",
                "--username",
                args.username,
                "--password",
                args.password,
                "--tenant",
                args.username,
                "--roles",
                "admin,indexer,reader",
            ],
            cwd=ROOT,
        )

        if run_spec["workload_kind"] == "seeded":
            cmd = compose_base + [
                "exec",
                "-T",
                "gateway",
                "node",
                "scripts/run_seeded_workload.js",
                "--base-url",
                "http://127.0.0.1:3000",
                "--username",
                args.username,
                "--password",
                args.password,
                "--collection",
                collection,
                "--seed",
                str(seed),
                "--writes",
                str(int(workload.get("writes", 50000))),
                "--min-asks",
                str(int(workload.get("min_asks", 10000))),
                "--recall-k",
                str(int(workload.get("recall_k", 24))),
                "--ask-k",
                str(int(workload.get("ask_k", 48))),
                "--ttl-seconds",
                str(int(workload.get("ttl_seconds", 2592000))),
                "--snapshot-every",
                str(int(workload.get("snapshot_every", 1000))),
                "--concurrency",
                str(int(workload.get("concurrency", 12))),
                "--log-every",
                str(int(workload.get("log_every", 250))),
                "--request-timeout-ms",
                str(int(args.request_timeout_ms)),
                "--max-retries",
                str(int(args.max_retries)),
                "--telemetry-file",
                f"/app/telemetry/{telemetry_rel.as_posix()}",
                "--config-id",
                run_spec["config_id"],
                "--run-id",
                run_id,
            ]
            run_cmd(cmd, cwd=ROOT)
        else:
            scenario_text = json.dumps(scenario_cfg)
            scenario_b64 = base64.b64encode(scenario_text.encode("utf-8")).decode("ascii")
            workload_settings = scenario_cfg.get("workload", {})
            cmd = compose_base + [
                "exec",
                "-T",
                "gateway",
                "node",
                "scripts/run_scenario_workload.js",
                "--base-url",
                "http://127.0.0.1:3000",
                "--username",
                args.username,
                "--password",
                args.password,
                "--collection",
                collection,
                "--seed",
                str(seed),
                "--scenario-json-b64",
                scenario_b64,
                "--recall-k",
                str(int(workload_settings.get("recall_k", 24))),
                "--ask-k",
                str(int(workload_settings.get("ask_k", 48))),
                "--ttl-seconds",
                str(int(workload_settings.get("ttl_seconds", 2592000))),
                "--concurrency",
                str(int(workload_settings.get("concurrency", 12))),
                "--log-every",
                str(int(workload_settings.get("log_every", 250))),
                "--request-timeout-ms",
                str(int(args.request_timeout_ms)),
                "--max-retries",
                str(int(args.max_retries)),
                "--telemetry-file",
                f"/app/telemetry/{telemetry_rel.as_posix()}",
                "--config-id",
                run_spec["config_id"],
                "--run-id",
                run_id,
                "--policy",
                policy,
            ]
            run_cmd(cmd, cwd=ROOT)

        raw_logs = run_dir / "raw_logs.ndjson"
        if not telemetry_host.exists():
            raise FileNotFoundError(f"telemetry output missing: {telemetry_host}")
        shutil.copy2(telemetry_host, raw_logs)

        summarize_cmd = [
            sys.executable,
            str(EXPERIMENTS_DIR / "scripts" / "summarize_run.py"),
            "--input",
            str(raw_logs),
            "--output-dir",
            str(run_dir),
            "--run-id",
            run_id,
            "--policy",
            policy,
            "--scenario",
            scenario,
            "--seed",
            str(seed),
            "--config-id",
            run_spec["config_id"],
            "--config-file",
            run_spec.get("ablation_config_path") or run_spec.get("scenario_config_path") or run_spec.get("policy_config_path") or "",
            "--ablation-group",
            run_spec.get("ablation_group", ""),
            "--ablation-value",
            run_spec.get("ablation_value", ""),
            "--suite-id",
            suite_id,
        ]
        run_cmd(summarize_cmd, cwd=ROOT)

        run_meta["status"] = "completed"
    except Exception as exc:
        run_meta["status"] = "failed"
        run_meta["error"] = str(exc)
        (run_dir / "run_manifest.json").write_text(json.dumps(run_meta, indent=2), encoding="utf-8")
        if not args.continue_on_error:
            raise
    finally:
        run_meta["ended_at"] = now_utc_iso()
        (run_dir / "run_manifest.json").write_text(json.dumps(run_meta, indent=2), encoding="utf-8")

    return {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "policy": policy,
        "scenario": scenario,
        "seed": seed,
        "status": run_meta["status"],
        "config_id": run_spec["config_id"],
        "ablation_group": run_spec.get("ablation_group", ""),
        "ablation_value": run_spec.get("ablation_value", ""),
    }


def write_runs_index_files(suite_dir: Path, results: List[Dict[str, Any]]) -> None:
    (suite_dir / "runs_index.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    if not results:
        return
    with (suite_dir / "runs_index.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(results[0].keys()))
        writer.writeheader()
        for row in results:
            writer.writerow(row)


def main() -> None:
    args = parse_args()
    seeds = parse_seed_list(args.seeds)
    docker_bin = ensure_docker_bin(args.docker_bin)
    if not args.dry_run:
        ensure_docker_daemon_running(docker_bin)
    runs_root = Path(args.runs_root).resolve()
    artifacts_root = Path(args.artifacts_root).resolve()
    telemetry_root = Path(args.telemetry_root).resolve()

    resume_mode = bool(args.resume_suite_dir.strip())
    existing_suite_manifest: Dict[str, Any] = {}

    if resume_mode:
        suite_dir = Path(args.resume_suite_dir).resolve()
        if not suite_dir.exists():
            raise FileNotFoundError(f"resume suite directory not found: {suite_dir}")
        suite_id = suite_dir.name
        existing_suite_manifest = read_json_if_exists(suite_dir / "suite_manifest.json")
        compose_project = str(existing_suite_manifest.get("compose_project") or safe_name(f"{args.compose_project_prefix}_{suite_id}"))
        compose_ports = parse_compose_ports(existing_suite_manifest.get("compose_ports"), suite_id)
        print(f"[suite] resume mode enabled suite_id={suite_id}", flush=True)
    else:
        suite_id, suite_dir = unique_suite_dir(args.tag, runs_root)
        compose_project = safe_name(f"{args.compose_project_prefix}_{suite_id}")
        compose_ports = default_compose_ports_for_suite(suite_id)

    telemetry_suite_dir = telemetry_root / suite_id
    telemetry_suite_dir.mkdir(parents=True, exist_ok=True)

    cfg = load_all_configs()
    run_specs = build_suite_runs(args, cfg, seeds)
    existing_rows_by_stem = existing_index_by_stem(suite_dir) if resume_mode else {}

    git_commit = get_git_commit()
    machine_info = get_machine_info()

    manifest: Dict[str, Any] = dict(existing_suite_manifest) if resume_mode else {}
    manifest.setdefault("created_at", now_utc_iso())
    manifest.update(
        {
            "suite_id": suite_id,
            "suite": args.suite,
            "seeds": seeds,
            "quick_mode": bool(args.quick),
            "dry_run": bool(args.dry_run),
            "tag": args.tag,
            "compose_project": compose_project,
            "compose_ports": compose_ports,
            "git_commit": git_commit,
            "machine_info": machine_info,
            "run_count": len(run_specs),
            "workload_concurrency_override": int(args.workload_concurrency or 0),
            "runs_root": str(runs_root),
            "artifacts_root": str(artifacts_root),
            "telemetry_root": str(telemetry_root),
            "resume_mode": bool(resume_mode),
        }
    )
    if resume_mode:
        manifest["resumed_at"] = now_utc_iso()

    (suite_dir / "suite_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    results: List[Dict[str, Any]] = []
    total = len(run_specs)
    for idx, run_spec in enumerate(run_specs, start=1):
        base_stem = run_stem_for(run_spec, idx)
        run_stem_override = ""
        existing_run_dir = suite_dir / base_stem
        if resume_mode and existing_run_dir.exists():
            existing_result = existing_rows_by_stem.get(base_stem)
            existing_manifest_result = result_from_manifest(existing_run_dir, run_spec)
            existing_status = str(existing_manifest_result.get("status", "")).lower()
            if existing_status in {"completed", "dry_run"}:
                print(
                    f"[suite] ({idx}/{total}) skip existing status={existing_status} scenario={run_spec['scenario']} policy={run_spec['policy']} seed={run_spec['seed']} config={run_spec['config_id']}",
                    flush=True,
                )
                results.append(existing_result or existing_manifest_result)
                write_runs_index_files(suite_dir, results)
                continue
            if existing_status == "failed":
                completed_retry = completed_retry_result(base_stem, suite_dir, run_spec)
                if completed_retry:
                    print(
                        f"[suite] ({idx}/{total}) skip failed base (covered by completed retry) scenario={run_spec['scenario']} policy={run_spec['policy']} seed={run_spec['seed']} config={run_spec['config_id']}",
                        flush=True,
                    )
                    results.append(completed_retry)
                    write_runs_index_files(suite_dir, results)
                    continue
            if existing_status == "failed" and args.resume_skip_failed:
                print(
                    f"[suite] ({idx}/{total}) keep existing failed run scenario={run_spec['scenario']} policy={run_spec['policy']} seed={run_spec['seed']} config={run_spec['config_id']}",
                    flush=True,
                )
                results.append(existing_result or existing_manifest_result)
                write_runs_index_files(suite_dir, results)
                continue
            run_stem_override = next_retry_stem(base_stem, suite_dir)
            print(
                f"[suite] ({idx}/{total}) rerun existing status={existing_status or 'unknown'} with stem={run_stem_override} scenario={run_spec['scenario']} policy={run_spec['policy']} seed={run_spec['seed']} config={run_spec['config_id']}",
                flush=True,
            )
        else:
            print(
                f"[suite] ({idx}/{total}) scenario={run_spec['scenario']} policy={run_spec['policy']} seed={run_spec['seed']} config={run_spec['config_id']}",
                flush=True,
            )

        try:
            result = run_single(
                idx,
                total,
                run_spec,
                args,
                suite_id,
                suite_dir,
                telemetry_suite_dir,
                docker_bin,
                compose_project,
                compose_ports,
                git_commit,
                machine_info,
                run_stem_override=run_stem_override,
            )
            results.append(result)
            write_runs_index_files(suite_dir, results)
        except Exception:
            failed_dir = suite_dir / (run_stem_override or base_stem)
            results.append(result_from_manifest(failed_dir, run_spec, fallback_status="failed"))
            write_runs_index_files(suite_dir, results)
            raise

    write_runs_index_files(suite_dir, results)

    if not args.skip_analysis and not args.dry_run:
        artifacts_dir = artifacts_root / suite_id
        gen_cmd = [
            sys.executable,
            str(EXPERIMENTS_DIR / "scripts" / "generate_submission_artifacts.py"),
            "--suite-dir",
            str(suite_dir),
            "--artifacts-dir",
            str(artifacts_dir),
        ]
        run_cmd(gen_cmd, cwd=ROOT)

    manifest["ended_at"] = now_utc_iso()
    manifest["completed_runs"] = sum(1 for r in results if r.get("status") == "completed")
    manifest["failed_runs"] = sum(1 for r in results if r.get("status") == "failed")
    (suite_dir / "suite_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"[suite] done suite_id={suite_id}")
    print(f"[suite] runs_dir={suite_dir}")
    if not args.skip_analysis and not args.dry_run:
        print(f"[suite] artifacts_dir={artifacts_root / suite_id}")


if __name__ == "__main__":
    main()
