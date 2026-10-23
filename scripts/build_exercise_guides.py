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

"""Regenerates web/static/js/exercise-guides-data.js from the guide JSON."""

from web.exercise_guides import WEB_MODULE_PATH, render_web_module

if __name__ == "__main__":
    WEB_MODULE_PATH.write_text(render_web_module(), encoding="utf-8")
    print(f"wrote {WEB_MODULE_PATH}")
