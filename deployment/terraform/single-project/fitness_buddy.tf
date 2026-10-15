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

# Fitness Buddy application infrastructure (on top of the agents-cli scaffold):
# Firestore, Model Armor, Secret Manager, the web app on Cloud Run, Artifact
# Registry, and keyless GitHub Actions deploys via Workload Identity Federation.

variable "github_repository" {
  type        = string
  description = "GitHub repository allowed to deploy via Workload Identity Federation, as 'owner/name'. Empty disables WIF."
  default     = ""
}

variable "oauth_client_id" {
  type        = string
  description = "OAuth 2.0 web client ID used by Google Sign-In in the web app."
  default     = ""
}

variable "allowed_emails" {
  type        = string
  description = "Comma-separated Google accounts allowed to sign in to the web app."
  default     = ""
  sensitive   = true
}

variable "web_image" {
  type        = string
  description = "Initial container image for the web app; CI/CD deploys the real image afterwards."
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "model_armor_location" {
  type        = string
  description = "Regional location of the Model Armor template."
  default     = "us-east1"
}

locals {
  app_services = [
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "dlp.googleapis.com",
    "modelarmor.googleapis.com",
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ]
  web_sa_roles = [
    "roles/datastore.user",         # read dashboard data
    "roles/aiplatform.user",        # query the agent on Agent Runtime
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
    "roles/monitoring.metricWriter",
  ]
  deployer_roles = [
    "roles/aiplatform.admin",               # agents-cli deploy (Agent Runtime)
    "roles/run.admin",                      # deploy the web app
    "roles/iam.serviceAccountUser",         # act as runtime service accounts
    "roles/cloudbuild.builds.editor",       # build images / agent source
    "roles/artifactregistry.writer",
    "roles/storage.admin",                  # staging buckets used by deploys
    "roles/serviceusage.serviceUsageConsumer",
    "roles/logging.viewer",
    "roles/logging.logWriter",             # Cloud Build runs as this account
  ]
}

resource "google_project_service" "app_services" {
  for_each           = toset(local.app_services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
  depends_on         = [google_project_service.bootstrap]
}

# ---------------------------------------------------------------------------
# Firestore (Native mode): user profiles, plans, workout/meal/measurement logs.
# ---------------------------------------------------------------------------
resource "google_firestore_database" "default" {
  project         = var.project_id
  name            = "(default)"
  location_id     = var.region
  type            = "FIRESTORE_NATIVE"
  deletion_policy = "ABANDON"
  depends_on      = [google_project_service.app_services]
}

# ---------------------------------------------------------------------------
# Model Armor template used by app/plugins/model_armor_guard.py.
# ---------------------------------------------------------------------------
resource "google_model_armor_template" "guard" {
  project     = var.project_id
  location    = var.model_armor_location
  template_id = "${var.project_name}-guard"

  # Required by the API on updates; also logs every sanitize call for audit.
  template_metadata {
    log_sanitize_operations = true
  }

  filter_config {
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
    rai_settings {
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      # Fitness talk ("burn", "kill it", injuries) trips low-confidence danger
      # matches; only block high-confidence dangerous content here. Health
      # policy (calorie floor, dosing, red flags) is enforced by the judge plugin.
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "HIGH"
      }
    }
  }
  depends_on = [google_project_service.app_services]
}

# ---------------------------------------------------------------------------
# Secret Manager: web session signing key (never in code or in the repo).
# ---------------------------------------------------------------------------
resource "random_password" "web_session_secret" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "web_session_secret" {
  project   = var.project_id
  secret_id = "${var.project_name}-web-session-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.app_services]
}

resource "google_secret_manager_secret_version" "web_session_secret" {
  secret      = google_secret_manager_secret.web_session_secret.id
  secret_data = random_password.web_session_secret.result
}

# ---------------------------------------------------------------------------
# Agent runtime service account (least privilege). The agent runs as this
# account on Agent Runtime: Firestore and the regional Model Armor endpoint do
# not accept Agent Identity credentials, so a dedicated SA is used instead.
# ---------------------------------------------------------------------------
locals {
  agent_sa_roles = [
    "roles/aiplatform.user",                  # Gemini, Sessions, Memory Bank
    "roles/datastore.user",                   # Firestore user data
    "roles/dlp.user",                         # PII redaction
    "roles/modelarmor.user",                  # prompt / response screening
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
    "roles/monitoring.metricWriter",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/telemetry.writer",                 # OTLP traces
  ]
}

resource "google_service_account" "agent" {
  project      = var.project_id
  account_id   = "${var.project_name}-agent"
  display_name = "Fitness Buddy agent runtime"
}

resource "google_project_iam_member" "agent_sa_roles" {
  for_each = toset(local.agent_sa_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.agent.email}"
}

resource "google_storage_bucket_iam_member" "agent_sa_logs_bucket" {
  bucket = google_storage_bucket.logs_data_bucket.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent.email}"
}

# The deployer (CI) attaches this SA to the Agent Runtime resource.
resource "google_service_account_iam_member" "deployer_acts_as_agent" {
  service_account_id = google_service_account.agent.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# ---------------------------------------------------------------------------
# Web app: service account, Artifact Registry and Cloud Run service.
# ---------------------------------------------------------------------------
resource "google_service_account" "web" {
  project      = var.project_id
  account_id   = "${var.project_name}-web"
  display_name = "Fitness Buddy web app"
}

resource "google_project_iam_member" "web_roles" {
  for_each = toset(local.web_sa_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.web.email}"
}

resource "google_secret_manager_secret_iam_member" "web_session_secret_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.web_session_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = var.project_name
  format        = "DOCKER"
  description   = "Fitness Buddy container images"
  depends_on    = [google_project_service.app_services]
}

resource "google_cloud_run_v2_service" "web" {
  project             = var.project_id
  name                = "${var.project_name}-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  # Public HTTPS endpoint; authentication is enforced in the app (Google
  # Sign-In + allowlist), so Cloud Run IAM invoker checks are disabled.
  invoker_iam_disabled = true

  template {
    service_account = google_service_account.web.email
    scaling {
      max_instance_count = 3
    }
    containers {
      image = var.web_image
      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "AGENT_BACKEND"
        value = "agent_runtime"
      }
      env {
        name  = "AGENT_RUNTIME_RESOURCE"
        value = google_vertex_ai_reasoning_engine.app.id
      }
      env {
        name  = "AGENT_RUNTIME_LOCATION"
        value = var.region
      }
      env {
        name  = "FITNESS_STORAGE_BACKEND"
        value = "firestore"
      }
      env {
        name  = "GOOGLE_OAUTH_CLIENT_ID"
        value = var.oauth_client_id
      }
      env {
        name  = "ALLOWED_EMAILS"
        value = var.allowed_emails
      }
      env {
        name  = "OTEL_TO_CLOUD"
        value = "true"
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.web_session_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    # CI/CD deploys new images; Terraform owns everything else.
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_iam_member.web_session_secret_access,
  ]
}

# ---------------------------------------------------------------------------
# Keyless CI/CD: GitHub Actions -> Workload Identity Federation -> deployer SA.
# ---------------------------------------------------------------------------
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "${var.project_name}-deployer"
  display_name = "Fitness Buddy CI/CD deployer (GitHub Actions)"
}

resource "google_project_iam_member" "deployer_roles" {
  for_each = toset(local.deployer_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = var.github_repository == "" ? 0 : 1
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.app_services]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.github_repository == "" ? 0 : 1
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Only this repository can mint credentials.
  attribute_condition = "assertion.repository == '${var.github_repository}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deployer_wif" {
  count              = var.github_repository == "" ? 0 : 1
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repository}"
}
