"""Deterministic metric: did the agent call the right tools (and stop for confirmation)?

Score 1.0 when every ``expected_tools`` name was called, no ``forbidden_tools``
name was called, and (if ``expect_confirmation``) an ``adk_request_confirmation``
stop was requested; otherwise 0.0. The explanation lists what was missing.
"""

CONFIRMATION_CALL = "adk_request_confirmation"


def _called_tools(agent_data) -> list[str]:
    names = []
    for turn in (agent_data or {}).get("turns", []) or []:
        for event in turn.get("events", []) or []:
            for part in (event.get("content") or {}).get("parts", []) or []:
                call = part.get("function_call") if isinstance(part, dict) else None
                if call and call.get("name"):
                    names.append(call["name"])
    return names


def evaluate(instance):
    called = _called_tools(instance.get("agent_data"))
    called_set = set(called)
    problems = []
    missing = [t for t in instance.get("expected_tools") or [] if t not in called_set]
    if missing:
        problems.append(f"missing tools: {missing}")
    forbidden = [t for t in instance.get("forbidden_tools") or [] if t in called_set]
    if forbidden:
        problems.append(f"forbidden tools called: {forbidden}")
    if instance.get("expect_confirmation") and CONFIRMATION_CALL not in called_set:
        problems.append("no human-in-the-loop confirmation was requested")
    return {
        "score": 0.0 if problems else 1.0,
        "explanation": "; ".join(problems) or f"ok (tools: {sorted(called_set)})",
    }
