"""Prints a per-case table for the latest (or given) eval results file.

Usage: uv run python tests/eval/summarize_results.py [results.json]
"""

import glob
import json
import sys


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else sorted(glob.glob("artifacts/grade_results/results_*.json"))[-1]
    data = json.load(open(path, encoding="utf-8"))
    ds = data.get("evaluation_dataset") or {}
    if isinstance(ds, list):
        ds = ds[0] if ds else {}
    cases = ds.get("eval_cases") or []
    print(f"Results: {path}\n")
    for result in data["eval_case_results"]:
        idx = result["eval_case_index"]
        case_id = cases[idx].get("eval_case_id", f"case_{idx}") if idx < len(cases) else f"case_{idx}"
        metrics = result["response_candidate_results"][0]["metric_results"]
        scores = {k: v.get("score") for k, v in metrics.items()}
        failing = {k: v.get("explanation") for k, v in metrics.items()
                   if v.get("score") is not None and ((k == "custom_response_quality" and v["score"] < 4) or (k != "custom_response_quality" and v["score"] < 1))}
        flag = "FAIL" if failing else "ok  "
        print(f"{flag} {case_id:32s} " + "  ".join(f"{k.split('_')[0]}={s}" for k, s in scores.items()))
        for k, why in failing.items():
            print(f"       - {k}: {why}")


if __name__ == "__main__":
    main()
