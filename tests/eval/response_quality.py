"""Local LLM-as-judge for `custom_response_quality` (see eval_config.yaml)."""

import json
import threading

from google import genai
from google.genai import types
from pydantic import BaseModel

_local = threading.local()


class _Verdict(BaseModel):
    score: int  # 1-5
    explanation: str


# A stalled judge request must not hang the eval gate forever (it did, twice):
# time out each call and retry transient failures.
_HTTP_OPTIONS = types.HttpOptions(
    timeout=90_000,
    retry_options=types.HttpRetryOptions(attempts=4, initial_delay=2.0),
)


def _client() -> genai.Client:
    """One client per grading thread.

    The eval SDK grades cases on its own thread pool; this initialization runs once
    per thread. Avoids creating a new client for each eval case, which would re-do
    ADC and the TLS handshake every time. Each thread gets its own client, because
    google-auth freezes the SSL context after the first connection when a client
    certificate is present.
    """
    client = getattr(_local, "client", None)
    if client is None:
        # AI Studio (GEMINI_API_KEY) or Gemini platform (ADC).
        client = _local.client = genai.Client(http_options=_HTTP_OPTIONS)
    return client


def _user_visible_reply(instance) -> str:
    """What the user actually sees at the end of the run.

    When the run pauses on a human-in-the-loop confirmation, the web app shows a
    Confirm / Reject card with the proposed change; include it, together with
    any coach text after the last tool call (internal JSON from helper agents is
    not shown to users).
    """
    response = instance.get("response") or ""
    if isinstance(response, dict):
        response = " ".join(
            p.get("text", "") for p in response.get("parts", []) if isinstance(p, dict)
        )
    last_card = None
    for turn in (instance.get("agent_data") or {}).get("turns", []) or []:
        for event in turn.get("events", []) or []:
            for part in (event.get("content") or {}).get("parts", []) or []:
                call = part.get("function_call") if isinstance(part, dict) else None
                if call and call.get("name") == "adk_request_confirmation":
                    payload = (
                        (call.get("args") or {}).get("toolConfirmation") or {}
                    ).get("payload") or {}
                    last_card = payload
    if last_card:
        card = json.dumps(last_card, ensure_ascii=False)[:3000]
        text = "" if str(response).strip().startswith("{") else str(response)
        return f"{text}\n[Confirmation card shown to the user, with Confirm / Reject buttons]: {card}".strip()
    return str(response)


def evaluate(instance):
    reference = instance.get("reference")
    rubric = (
        "Grade the AI fitness coach's final response on a 1-5 scale (1 poor, 5 excellent) "
        "for accuracy (numbers match tool results), relevance to the user's goal and "
        "constraints, safety, and clarity/concision for a busy user."
    )
    if reference:
        rubric += (
            " The response should agree with the expected answer below; penalize "
            "factual disagreement with it."
        )
    prompt = (
        f"You are an expert QA evaluator for an AI fitness coach. {rubric}\n"
        f"User Prompt: {instance.get('prompt', '')}\n"
        f"Final Response: {_user_visible_reply(instance)}\n"
    )
    if reference:
        prompt += f"Expected Answer (ground truth): {reference}\n"
    prompt += f"Full Agent Trace: {instance.get('agent_data', '')}\n"

    response = _client().models.generate_content(
        model="gemini-3.8-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0,  # deterministic grading
            response_mime_type="application/json",
            response_schema=_Verdict,  # guaranteed schema-valid JSON
        ),
    )
    verdict = response.parsed
    if verdict is None:  # model returned nothing usable
        return {"score": 0, "explanation": response.text or ""}
    return {"score": max(1, min(5, verdict.score)), "explanation": verdict.explanation}
