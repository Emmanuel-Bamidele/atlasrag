# AtlasRAG Experiment Suite

Submission experiment harness for AMV-L vs TTL vs LRU with stress scenarios and AMV-L ablations.

## Layout

- `experiments/configs/`: policy, stress, and ablation config overrides.
- `experiments/scripts/`: runners + summarization + plotting.
- `telemetry/experiments_runs/`: timestamped run outputs (default).
- `telemetry/experiments_artifacts/`: copied plots/tables bundles (default).
- `telemetry/experiments_event_logs/`: per-run NDJSON event files (default).

## Run One Experiment (single run)

Use `--max-runs 1` and target a suite class.

```bash
python3 experiments/scripts/run_submission_suite.py --suite baseline --max-runs 1 --seeds 1337 --tag one_run
```

This creates a new directory:

- `telemetry/experiments_runs/<timestamp>_one_run/`

Each run directory contains:

- `raw_logs.ndjson`
- `summary.json`
- `results.csv` (single-row run metrics)
- `request_latencies.csv`
- `memory_candidates.csv`
- `prompt_tokens.csv`
- `memory_snapshot_counts.csv`
- `run_manifest.json` (config, git commit, seed, machine info, timestamps)

## Run Full Suite

```bash
python3 experiments/scripts/run_submission_suite.py --suite full --seeds 1337,2027,3037 --tag submission_full
```

If your machine hits DB timeout under heavy parallel load, lower runner concurrency:

```bash
python3 experiments/scripts/run_submission_suite.py --suite full --seeds 1337,2027,3037 --workload-concurrency 8 --tag submission_full
```

Each suite run uses an isolated Docker Compose project by default (project name derived from suite id), so runs start from clean service volumes and avoid cross-run data interference.

Helper wrappers:

```bash
experiments/scripts/run_baselines.sh --seeds 1337,2027,3037 --tag baselines_full
experiments/scripts/run_stress.sh --seeds 1337,2027,3037 --tag stress_full
experiments/scripts/run_ablations.sh --seeds 1337,2027,3037 --tag ablations_full
experiments/scripts/run_full_suite.sh --seeds 1337,2027,3037 --tag full_suite
```

Optional smoke run:

```bash
python3 experiments/scripts/run_submission_suite.py --suite full --quick --max-runs 6 --tag smoke
```

Optional explicit output roots:

```bash
python3 experiments/scripts/run_submission_suite.py \
  --suite full \
  --runs-root telemetry/experiments_runs \
  --artifacts-root telemetry/experiments_artifacts \
  --telemetry-root telemetry/experiments_event_logs \
  --tag submission_full
```

## Regenerate Plots/Tables from Existing Runs

```bash
python3 experiments/scripts/generate_submission_artifacts.py \
  --suite-dir telemetry/experiments_runs/<suite_id> \
  --artifacts-dir telemetry/experiments_artifacts/<suite_id>
```

Generated outputs include:

- Tables (`CSV`):
  - `baseline_comparison.csv`
  - `phase_shift.csv`
  - `bursty_write.csv`
  - `aged_recall.csv`
  - `ablation_lambda.csv`
  - `ablation_k.csv`
  - `ablation_alpha_beta.csv`
- Plots (`PNG` + `PDF`):
  - `latency_ccdf_baseline`
  - `candidate_set_size_distribution`
  - `vectors_scanned_distribution`
  - `throughput_over_time`
  - `hot_warm_cold_counts_over_time`
  - `ablation_param_vs_p99_latency`
  - `ablation_param_vs_gt2s_fraction`
- Suite summary:
  - `summary.md` (coverage + missing scenario diagnostics + baseline highlights)

## Notes

- The harness does not change AMV-L/TTL/LRU control logic.
- All policy changes are per-run env overrides only.
- Every run writes to a new timestamped directory; existing outputs are not overwritten.
