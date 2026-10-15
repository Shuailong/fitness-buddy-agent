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

output "agent_runtime_resource" {
  description = "Agent Runtime resource name (write into deployment_metadata.json before agents-cli deploy)."
  value       = google_vertex_ai_reasoning_engine.app.id
}

output "web_url" {
  description = "Public URL of the web app (add it as an authorized JavaScript origin on the OAuth client)."
  value       = google_cloud_run_v2_service.web.uri
}

output "web_service_account" {
  value = google_service_account.web.email
}

output "deployer_service_account" {
  description = "Service account GitHub Actions impersonates (GitHub secret GCP_SERVICE_ACCOUNT)."
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Full WIF provider name (GitHub secret WIF_PROVIDER)."
  value       = var.github_repository == "" ? null : google_iam_workload_identity_pool_provider.github[0].name
}

output "artifact_registry_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

output "model_armor_template_id" {
  value = google_model_armor_template.guard.template_id
}
