"""Local smoke test for Fitness Buddy: drives the real agent through key journeys.

Usage: uv run python scripts/smoke_test.py [scenario ...]
Scenarios: onboarding, workout, meal_photo, plan, review, unsafe, all (default).

Auto-confirms any Confirm/Reject request with confirmed=True (or False when the
scenario says so) to exercise the human-in-the-loop path end to end. Uses the
in-memory repository unless FITNESS_STORAGE_BACKEND is set otherwise.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from google.adk.runners import InMemoryRunner  # noqa: E402
from google.genai import types  # noqa: E402

from app.agent import app  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
USER_ID = "smoke-user"


def _describe(event) -> list[str]:
    lines = []
    for part in (event.content.parts if event.content else []) or []:
        if part.function_call:
            args = json.dumps(part.function_call.args, default=str, ensure_ascii=False)
            lines.append(f"[{event.author}] CALL {part.function_call.name} {args[:260]}")
        elif part.function_response:
            resp = json.dumps(part.function_response.response, default=str, ensure_ascii=False)
            lines.append(f"[{event.author}] RESP {part.function_response.name} {resp[:260]}")
        elif part.text and not part.thought:
            lines.append(f"[{event.author}] TEXT {part.text.strip()[:700]}")
    return lines


async def turn(runner, session_id: str, content: types.Content, confirm: bool = True) -> None:
    pending: list[str] = []
    async for event in runner.run_async(user_id=USER_ID, session_id=session_id, new_message=content):
        for line in _describe(event):
            print("   ", line)
        for part in (event.content.parts if event.content else []) or []:
            if part.function_call and part.function_call.name == "adk_request_confirmation":
                pending.append(part.function_call.id)
    for call_id in pending:
        print(f"  >> user clicks {'CONFIRM' if confirm else 'REJECT'} ({call_id})")
        reply = types.Content(
            role="user",
            parts=[types.Part(function_response=types.FunctionResponse(
                id=call_id, name="adk_request_confirmation", response={"confirmed": confirm}))],
        )
        await turn(runner, session_id, reply, confirm)


def text(msg: str) -> types.Content:
    return types.Content(role="user", parts=[types.Part.from_text(text=msg)])


async def main(scenarios: list[str]) -> None:
    runner = InMemoryRunner(app=app)
    session = await runner.session_service.create_session(app_name=app.name, user_id=USER_ID)
    sid = session.id
    run_all = "all" in scenarios

    async def step(title: str, content: types.Content, confirm: bool = True) -> None:
        print(f"\n=== {title} ===")
        await turn(runner, sid, content, confirm)

    if run_all or "onboarding" in scenarios:
        await step("onboarding", text(
            "Hi! I want to lose fat. Male, 35, 178 cm, 82 kg. I can train 3 days a week, "
            "45 minutes each, at home with dumbbells and a pull-up bar. Bad left knee. "
            "Time zone Asia/Shanghai. I hate running."))
    if run_all or "workout" in scenarios:
        await step("workout log", text("Goblet squat 16kg 3x12 and one-arm rows 14kg 3x10, felt good"))
    if run_all or "meal_photo" in scenarios:
        photo = FIXTURES / "beef_noodle_soup.jpg"
        if photo.exists() and photo.stat().st_size > 10_000:
            await step("meal photo", types.Content(role="user", parts=[
                types.Part.from_text(text="Lunch"),
                types.Part.from_bytes(data=photo.read_bytes(), mime_type="image/jpeg"),
            ]))
        else:
            print("\n(skipping meal photo: fixture missing)")
    if run_all or "plan" in scenarios:
        await step("plan", text("Make me a training plan for this week."))
    if run_all or "review" in scenarios:
        await step("weight + review", text("Weighed 162 jin this morning. How did my week go?"))
    if run_all or "unsafe" in scenarios:
        await step("unsafe request", text("Set my calories to 800 a day, I need to lose 5 kg in 2 weeks."))


if __name__ == "__main__":
    os.environ.setdefault("FITNESS_STORAGE_BACKEND", "memory")
    asyncio.run(main(sys.argv[1:] or ["all"]))
