#!/usr/bin/env python3
"""Generate submission-ready tables and plots from a suite run directory."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
from pathlib import Path
from typing import Dict, List, Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate tables/plots for submission")
    parser.add_argument("--suite-dir", required=True)
    parser.add_argument("--artifacts-dir", required=False, default="")
    return parser.parse_args()


def ensure_number(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def save_fig(fig: plt.Figure, out_dir: Path, stem: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_dir / f"{stem}.png", dpi=220, bbox_inches="tight")
    fig.savefig(out_dir / f"{stem}.pdf", bbox_inches="tight")
    plt.close(fig)


def load_suite_rows(suite_dir: Path) -> pd.DataFrame:
    index_path = suite_dir / "runs_index.json"
    if not index_path.exists():
        raise FileNotFoundError(f"missing runs index: {index_path}")
    rows = json.loads(index_path.read_text(encoding="utf-8"))
    merged: List[Dict] = []
    for row in rows:
        run_dir = Path(str(row.get("run_dir", "")))
        if not run_dir.exists():
            fallback = suite_dir / run_dir.name
            if fallback.exists():
                run_dir = fallback
        result_path = run_dir / "results.csv"
        if not result_path.exists():
            continue
        frame = pd.read_csv(result_path)
        if frame.empty:
            continue
        result = frame.iloc[0].to_dict()
        merged.append({**row, **result})
    if not merged:
        raise RuntimeError("no run results found")
    return pd.DataFrame(merged)


def summarize_by_group(df: pd.DataFrame, group_cols: List[str]) -> pd.DataFrame:
    metrics = [
        "request_count",
        "latency_p50_ms",
        "latency_p95_ms",
        "latency_p99_ms",
        "throughput_req_per_s",
        "fraction_gt_1s",
        "fraction_gt_2s",
        "success_rate",
        "candidate_set_p95",
        "vectors_scanned_p95",
        "vectors_scanned_mean",
        "prompt_tokens_mean",
        "prompt_tokens_p95",
        "write_latency_p95_ms",
        "recall_latency_p95_ms",
        "ask_latency_p95_ms",
    ]
    for metric in metrics:
        if metric in df.columns:
            df[metric] = ensure_number(df[metric])
    grouped = (
        df.groupby(group_cols, dropna=False)[metrics]
        .agg(["mean", "std", "min", "max"])
        .reset_index()
    )
    grouped.columns = [
        "_".join([str(c) for c in col if c]).rstrip("_") if isinstance(col, tuple) else str(col)
        for col in grouped.columns
    ]
    seed_counts = df.groupby(group_cols, dropna=False)["seed"].nunique().reset_index(name="seed_count")
    return grouped.merge(seed_counts, on=group_cols, how="left")


def read_metric_values(run_dirs: List[Path], csv_name: str, column: str) -> Dict[str, np.ndarray]:
    values: Dict[str, List[float]] = {}
    for run_dir in run_dirs:
        policy = run_dir.name.split("__", 1)[0]
        csv_path = run_dir / csv_name
        if not csv_path.exists():
            continue
        frame = pd.read_csv(csv_path)
        if column not in frame.columns:
            continue
        vals = pd.to_numeric(frame[column], errors="coerce").dropna().values
        if vals.size == 0:
            continue
        values.setdefault(policy, []).extend(vals.tolist())
    return {k: np.array(v, dtype=float) for k, v in values.items()}


def build_latency_ccdf(df: pd.DataFrame, plot_dir: Path) -> None:
    baseline = df[df["scenario"] == "baseline"]
    fig, ax = plt.subplots(figsize=(8.5, 5.2))

    for policy in sorted(baseline["policy"].dropna().unique()):
        vals: List[float] = []
        runs = baseline[baseline["policy"] == policy]
        for _, row in runs.iterrows():
            req_path = Path(row["run_dir"]) / "request_latencies.csv"
            if not req_path.exists():
                continue
            req = pd.read_csv(req_path)
            lat = pd.to_numeric(req.get("latency_ms"), errors="coerce").dropna().values
            if lat.size > 0:
                vals.extend(lat.tolist())
        if not vals:
            continue
        ordered = np.sort(np.array(vals, dtype=float))
        ccdf = 1.0 - (np.arange(1, ordered.size + 1) / ordered.size)
        ax.step(ordered, ccdf, where="post", label=policy)

    ax.set_xlabel("Latency (ms)")
    ax.set_ylabel("CCDF")
    ax.set_title("Latency CCDF (Baseline Policies)")
    ax.grid(True, alpha=0.3)
    if ax.lines:
        ax.legend()
    else:
        ax.text(0.5, 0.5, "No baseline runs found", ha="center", va="center")
    save_fig(fig, plot_dir, "latency_ccdf_baseline")


def build_distribution_plot(df: pd.DataFrame, plot_dir: Path, csv_name: str, column: str, stem: str, title: str, xlabel: str) -> None:
    baseline = df[df["scenario"] == "baseline"]
    fig, ax = plt.subplots(figsize=(8.5, 5.2))

    for policy in sorted(baseline["policy"].dropna().unique()):
        values: List[float] = []
        runs = baseline[baseline["policy"] == policy]
        for _, row in runs.iterrows():
            csv_path = Path(row["run_dir"]) / csv_name
            if not csv_path.exists():
                continue
            frame = pd.read_csv(csv_path)
            if column not in frame.columns:
                continue
            vals = pd.to_numeric(frame[column], errors="coerce").dropna().values
            if vals.size > 0:
                values.extend(vals.tolist())
        if not values:
            continue
        arr = np.sort(np.array(values, dtype=float))
        ecdf = np.arange(1, arr.size + 1) / arr.size
        ax.step(arr, ecdf, where="post", label=policy)

    ax.set_xlabel(xlabel)
    ax.set_ylabel("CDF")
    ax.set_title(title)
    ax.grid(True, alpha=0.3)
    if ax.lines:
        ax.legend()
    else:
        ax.text(0.5, 0.5, "No baseline runs found", ha="center", va="center")
    save_fig(fig, plot_dir, stem)


def build_throughput_plot(df: pd.DataFrame, plot_dir: Path) -> None:
    baseline = df[df["scenario"] == "baseline"]
    fig, ax = plt.subplots(figsize=(9.0, 5.2))
    bin_seconds = 60

    for policy in sorted(baseline["policy"].dropna().unique()):
        series: List[pd.Series] = []
        runs = baseline[baseline["policy"] == policy]
        for _, row in runs.iterrows():
            req_path = Path(row["run_dir"]) / "request_latencies.csv"
            if not req_path.exists():
                continue
            req = pd.read_csv(req_path)
            t = pd.to_numeric(req.get("end_ts_ms"), errors="coerce").dropna()
            if t.empty:
                continue
            t0 = t.min()
            bins = ((t - t0) / (bin_seconds * 1000)).astype(int)
            counts = bins.value_counts().sort_index().astype(float) / bin_seconds
            series.append(counts)
        if not series:
            continue
        combined = pd.concat(series, axis=1).fillna(np.nan)
        mean_rate = combined.mean(axis=1, skipna=True)
        ax.plot(mean_rate.index * bin_seconds / 60.0, mean_rate.values, label=policy)

    ax.set_xlabel("Elapsed Time (minutes)")
    ax.set_ylabel("Throughput (req/s)")
    ax.set_title("Throughput Over Time (Baseline Policies)")
    ax.grid(True, alpha=0.3)
    if ax.lines:
        ax.legend()
    else:
        ax.text(0.5, 0.5, "No baseline runs found", ha="center", va="center")
    save_fig(fig, plot_dir, "throughput_over_time")


def build_tier_plot(df: pd.DataFrame, plot_dir: Path) -> None:
    baseline_amvl = df[(df["scenario"] == "baseline") & (df["policy"] == "AMV-L")]
    fig, ax = plt.subplots(figsize=(9.0, 5.2))
    if baseline_amvl.empty:
        ax.text(0.5, 0.5, "No AMV-L baseline runs found", ha="center", va="center")
        ax.set_axis_off()
        save_fig(fig, plot_dir, "hot_warm_cold_counts_over_time")
        return

    series_hot: List[pd.Series] = []
    series_warm: List[pd.Series] = []
    series_cold: List[pd.Series] = []

    for _, row in baseline_amvl.iterrows():
        snap_path = Path(row["run_dir"]) / "memory_snapshot_counts.csv"
        if not snap_path.exists():
            continue
        snap = pd.read_csv(snap_path)
        if snap.empty or "timestamp_ms" not in snap.columns:
            continue
        t = pd.to_numeric(snap["timestamp_ms"], errors="coerce")
        if t.dropna().empty:
            continue
        t0 = t.dropna().min()
        bins = np.floor((t - t0) / (60 * 1000))
        grouped = snap.copy()
        grouped["minute_bin"] = pd.to_numeric(bins, errors="coerce")
        grouped = grouped.dropna(subset=["minute_bin"])
        if grouped.empty:
            continue
        grouped["minute_bin"] = grouped["minute_bin"].astype(int)
        g = grouped.groupby("minute_bin").agg(
            hot=("hot_count", "mean"),
            warm=("warm_count", "mean"),
            cold=("cold_count", "mean"),
        )
        series_hot.append(g["hot"])
        series_warm.append(g["warm"])
        series_cold.append(g["cold"])

    if not series_hot:
        ax.text(0.5, 0.5, "No snapshot data found", ha="center", va="center")
        ax.set_axis_off()
        save_fig(fig, plot_dir, "hot_warm_cold_counts_over_time")
        return

    hot = pd.concat(series_hot, axis=1).mean(axis=1, skipna=True)
    warm = pd.concat(series_warm, axis=1).mean(axis=1, skipna=True)
    cold = pd.concat(series_cold, axis=1).mean(axis=1, skipna=True)

    ax.plot(hot.index, hot.values, label="hot_count")
    ax.plot(warm.index, warm.values, label="warm_count")
    ax.plot(cold.index, cold.values, label="cold_count")
    ax.set_xlabel("Elapsed Time (minutes)")
    ax.set_ylabel("Count")
    ax.set_title("Hot/Warm/Cold Counts Over Time (AMV-L Baseline)")
    ax.grid(True, alpha=0.3)
    ax.legend()
    save_fig(fig, plot_dir, "hot_warm_cold_counts_over_time")


def build_ablation_plots(df: pd.DataFrame, plot_dir: Path) -> None:
    abl = df[df["scenario"] == "ablation"].copy()
    if abl.empty:
        for stem, title in [
            ("ablation_param_vs_p99_latency", "Ablation Parameter vs p99 Latency"),
            ("ablation_param_vs_gt2s_fraction", "Ablation Parameter vs >2s Fraction"),
        ]:
            fig, ax = plt.subplots(figsize=(8.0, 4.8))
            ax.text(0.5, 0.5, "No ablation runs found", ha="center", va="center")
            ax.set_title(title)
            ax.set_axis_off()
            save_fig(fig, plot_dir, stem)
        return

    abl["latency_p99_ms"] = ensure_number(abl["latency_p99_ms"])
    abl["fraction_gt_2s"] = ensure_number(abl["fraction_gt_2s"])

    for metric, stem, title, ylabel in [
        ("latency_p99_ms", "ablation_param_vs_p99_latency", "Ablation Parameter vs p99 Latency", "p99 latency (ms)"),
        ("fraction_gt_2s", "ablation_param_vs_gt2s_fraction", "Ablation Parameter vs >2s Fraction", "Fraction >2s"),
    ]:
        fig, axes = plt.subplots(1, 3, figsize=(14.5, 4.8), constrained_layout=True)
        groups = ["lambda", "k", "alpha_beta"]
        for idx, group in enumerate(groups):
            ax = axes[idx]
            gdf = abl[abl["ablation_group"] == group].copy()
            ax.set_title(group)
            if gdf.empty:
                ax.text(0.5, 0.5, "no data", ha="center", va="center")
                ax.set_axis_off()
                continue

            if group in {"lambda", "k"}:
                gdf["x"] = pd.to_numeric(gdf["ablation_value"], errors="coerce")
                gdf = gdf.dropna(subset=["x", metric])
                if gdf.empty:
                    ax.text(0.5, 0.5, "no numeric data", ha="center", va="center")
                    ax.set_axis_off()
                    continue
                agg = gdf.groupby("x", as_index=False)[metric].mean().sort_values("x")
                ax.plot(agg["x"], agg[metric], marker="o")
                ax.set_xlabel("parameter")
            else:
                agg = gdf.groupby("ablation_value", as_index=False)[metric].mean()
                agg = agg.sort_values("ablation_value")
                ax.plot(np.arange(len(agg)), agg[metric], marker="o")
                ax.set_xticks(np.arange(len(agg)))
                ax.set_xticklabels(agg["ablation_value"], rotation=20, ha="right")
                ax.set_xlabel("alpha/beta setting")

            ax.set_ylabel(ylabel)
            ax.grid(True, alpha=0.3)

        fig.suptitle(title)
        save_fig(fig, plot_dir, stem)


def copy_artifacts(suite_dir: Path, artifacts_dir: Path) -> None:
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    for name in ["plots", "tables", "results.csv", "runs_index.json", "suite_manifest.json", "summary.md"]:
        src = suite_dir / name
        if not src.exists():
            continue
        dst = artifacts_dir / name
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)


def _fmt_num(value: object, digits: int = 3) -> str:
    try:
        v = float(value)  # type: ignore[arg-type]
    except Exception:
        return "n/a"
    if np.isnan(v) or np.isinf(v):
        return "n/a"
    return f"{v:.{digits}f}"


def write_summary_markdown(suite_dir: Path, df: pd.DataFrame) -> None:
    lines: List[str] = []
    lines.append("# Experiment Summary")
    lines.append("")
    lines.append(f"Generated: {dt.datetime.utcnow().isoformat()}Z")
    lines.append(f"Suite directory: `{suite_dir}`")
    lines.append("")

    total_runs = int(len(df.index))
    lines.append("## Coverage")
    lines.append("")
    lines.append(f"- Total runs in suite index: **{total_runs}**")
    scenario_counts = df["scenario"].value_counts(dropna=False).to_dict()
    policy_counts = df["policy"].value_counts(dropna=False).to_dict()
    lines.append("- Runs by scenario:")
    for key in sorted(str(k) for k in scenario_counts.keys()):
        lines.append(f"  - `{key}`: {int(scenario_counts.get(key, 0))}")
    lines.append("- Runs by policy:")
    for key in sorted(str(k) for k in policy_counts.keys()):
        lines.append(f"  - `{key}`: {int(policy_counts.get(key, 0))}")
    lines.append("")

    required_scenarios = ["baseline", "phase_shift", "bursty_write", "aged_recall", "ablation"]
    missing = [name for name in required_scenarios if int(scenario_counts.get(name, 0)) == 0]
    if missing:
        lines.append("## Missing Data")
        lines.append("")
        lines.append(
            f"- Missing scenario run groups: {', '.join(f'`{m}`' for m in missing)}"
        )
        if "ablation" in missing:
            lines.append("- Ablation plots are placeholders because this suite has no ablation runs.")
        lines.append("")

    baseline = df[df["scenario"] == "baseline"].copy()
    if not baseline.empty:
        baseline["latency_p99_ms"] = pd.to_numeric(baseline["latency_p99_ms"], errors="coerce")
        baseline["throughput_req_per_s"] = pd.to_numeric(baseline["throughput_req_per_s"], errors="coerce")
        baseline["fraction_gt_2s"] = pd.to_numeric(baseline["fraction_gt_2s"], errors="coerce")
        grouped = (
            baseline.groupby("policy", dropna=False)[["latency_p99_ms", "throughput_req_per_s", "fraction_gt_2s"]]
            .mean()
            .reset_index()
        )

        lines.append("## Baseline Highlights")
        lines.append("")
        lines.append("| Policy | mean p99 latency (ms) | mean throughput (req/s) | mean >2s fraction |")
        lines.append("| --- | ---: | ---: | ---: |")
        for _, row in grouped.sort_values("policy").iterrows():
            lines.append(
                f"| {row['policy']} | {_fmt_num(row['latency_p99_ms'], 2)} | {_fmt_num(row['throughput_req_per_s'], 3)} | {_fmt_num(row['fraction_gt_2s'], 6)} |"
            )
        lines.append("")

    lines.append("## Output Paths")
    lines.append("")
    lines.append(f"- Tables: `{suite_dir / 'tables'}`")
    lines.append(f"- Plots: `{suite_dir / 'plots'}`")
    lines.append(f"- Per-run folders: `{suite_dir}`")
    lines.append("")

    lines.append("## Re-run Guidance")
    lines.append("")
    lines.append("- To populate ablation plots, run the ablation suite and regenerate artifacts:")
    lines.append("  - `python3 experiments/scripts/run_submission_suite.py --suite ablation --seeds 1337,2027,3037 --tag <tag>`")
    lines.append("  - `python3 experiments/scripts/generate_submission_artifacts.py --suite-dir telemetry/experiments_runs/<suite_id> --artifacts-dir telemetry/experiments_artifacts/<suite_id>`")
    lines.append("")

    (suite_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    args = parse_args()
    suite_dir = Path(args.suite_dir).resolve()
    plot_dir = suite_dir / "plots"
    table_dir = suite_dir / "tables"
    table_dir.mkdir(parents=True, exist_ok=True)

    df = load_suite_rows(suite_dir)

    for col in ["seed", "scenario", "policy", "ablation_group", "ablation_value"]:
        if col not in df.columns:
            df[col] = ""

    df.to_csv(suite_dir / "results.csv", index=False)

    baseline = summarize_by_group(df[df["scenario"] == "baseline"].copy(), ["policy"])
    phase = summarize_by_group(df[df["scenario"] == "phase_shift"].copy(), ["policy"])
    burst = summarize_by_group(df[df["scenario"] == "bursty_write"].copy(), ["policy"])
    aged = summarize_by_group(df[df["scenario"] == "aged_recall"].copy(), ["policy"])

    abl = df[df["scenario"] == "ablation"].copy()
    abl_lambda = summarize_by_group(abl[abl["ablation_group"] == "lambda"].copy(), ["ablation_value"])
    abl_k = summarize_by_group(abl[abl["ablation_group"] == "k"].copy(), ["ablation_value"])
    abl_ab = summarize_by_group(abl[abl["ablation_group"] == "alpha_beta"].copy(), ["ablation_value"])

    baseline.to_csv(table_dir / "baseline_comparison.csv", index=False)
    phase.to_csv(table_dir / "phase_shift.csv", index=False)
    burst.to_csv(table_dir / "bursty_write.csv", index=False)
    aged.to_csv(table_dir / "aged_recall.csv", index=False)
    abl_lambda.to_csv(table_dir / "ablation_lambda.csv", index=False)
    abl_k.to_csv(table_dir / "ablation_k.csv", index=False)
    abl_ab.to_csv(table_dir / "ablation_alpha_beta.csv", index=False)

    build_latency_ccdf(df, plot_dir)
    build_distribution_plot(
        df,
        plot_dir,
        csv_name="memory_candidates.csv",
        column="candidate_set_size_R",
        stem="candidate_set_size_distribution",
        title="Candidate Set Size Distribution (Baseline Policies)",
        xlabel="Candidate set size R",
    )
    build_distribution_plot(
        df,
        plot_dir,
        csv_name="memory_candidates.csv",
        column="vectors_scanned",
        stem="vectors_scanned_distribution",
        title="Vectors Scanned Distribution (Baseline Policies)",
        xlabel="Vectors scanned",
    )
    build_throughput_plot(df, plot_dir)
    build_tier_plot(df, plot_dir)
    build_ablation_plots(df, plot_dir)
    write_summary_markdown(suite_dir, df)

    if args.artifacts_dir:
        copy_artifacts(suite_dir, Path(args.artifacts_dir).resolve())


if __name__ == "__main__":
    main()
