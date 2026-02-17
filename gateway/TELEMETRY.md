# Temporary Telemetry Workflow

## 1) Enable telemetry for an experiment run

Set these environment variables before starting the gateway:

```bash
export TELEMETRY_ENABLED=1
export TELEMETRY_CONFIG_ID="baseline-a"          # label the system configuration
export TELEMETRY_RUN_ID="2026-02-14-baseline-a"  # optional explicit run label
export TELEMETRY_FILE="./telemetry/events.ndjson"
export TELEMETRY_SNAPSHOT_INTERVAL_MS=300000     # default 5 minutes
```

Then run the gateway normally and use the system for a few hours.

## 2) Analyze telemetry offline

Run:

```bash
node scripts/analyze_telemetry.js --input telemetry/events.ndjson --out telemetry_analysis
```

Outputs:

- `telemetry_analysis/csv/` clean tabular datasets
- `telemetry_analysis/plots/` PNG plots
- `telemetry_analysis/summary.md` short markdown report

## 3) Compare multiple configurations

Repeat runs with different `TELEMETRY_CONFIG_ID` values (and optionally different `TELEMETRY_RUN_ID` values) while appending to the same NDJSON file.  
The analyzer auto-separates by `config_id` and `run_id`.
