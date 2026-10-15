# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Fitness Buddy domain core.

Pure, deterministic domain logic shared by the ADK agent tools (``app/``) and the
web app dashboard (``web/``): Pydantic domain models, energy and macro targets,
unit normalization, nutrition summaries, trends, training-plan validation,
weekly progress, check-ins, and the persistence repository.

Design rule: every number the user sees (targets, totals, trends, adherence) is
computed here, never by the LLM. The only model-generated numbers are per-item
food estimates from meal photos.
"""
