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

# Production operations: Firestore backups and TTL, log-based metrics, alerting
# (email channel, uptime check, alert policies) and the usage dashboard.
# Runbooks for every alert live in docs/OPERATIONS.md.

variable "alert_emails" {
  type        = string
  description = "Comma-separated email addresses that receive alert and budget notifications. Pass at plan time (never commit). Empty creates the policies without notifications."
}

variable "uptime_host" {
  type        = string
  description = "Public hostname of the web app probed by the uptime check (e.g. the custom domain). Empty skips the uptime check and its alert."
}

variable "uptime_path" {
  type        = string
  description = "Path probed by the uptime check. Cloud Run reserves paths ending in 'z' (e.g. /healthz returns a Google 404 at the edge), so do not use /healthz here."
  default     = "/"
}

variable "firestore_backup_retention_days" {
  type        = number
  description = "Retention of the daily Firestore backups."
  default     = 14
}

locals {
  alert_email_list = compact([for e in split(",", var.alert_emails) : trimspace(e)])
  notification_channels = [
    for c in google_monitoring_notification_channel.email : c.id
  ]

  # The agent's numeric Agent Runtime id (last segment of the resource name).
  agent_engine_id = reverse(split("/", google_vertex_ai_reasoning_engine.app.id))[0]

  web_service_name = google_cloud_run_v2_service.web.name

  web_log_filter   = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.web_service_name}\""
  agent_log_filter = "resource.type=\"aiplatform.googleapis.com/ReasoningEngine\" AND resource.labels.reasoning_engine_id=\"${local.agent_engine_id}\""

  runbook_url = var.github_repository == "" ? "docs/OPERATIONS.md" : "https://github.com/${var.github_repository}/blob/main/docs/OPERATIONS.md"

  user_metric_prefix = "logging.googleapis.com/user"
}

# ---------------------------------------------------------------------------
# Firestore data safety (PITR and delete protection are on the database
# resource in fitness_buddy.tf).
# ---------------------------------------------------------------------------
resource "google_firestore_backup_schedule" "daily" {
  project   = var.project_id
  database  = google_firestore_database.default.name
  retention = "${var.firestore_backup_retention_days * 86400}s"

  daily_recurrence {}
}

# Rate-limit counters expire automatically: Firestore deletes documents in the
# `rate_limits` collection group once their `expire_at` timestamp has passed.
resource "google_firestore_field" "rate_limits_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "rate_limits"
  field      = "expire_at"

  ttl_config {}
}

# ---------------------------------------------------------------------------
# Log-based metrics (from the structured logs in web/observability.py and
# app/observability/structured_logging.py).
# ---------------------------------------------------------------------------
resource "google_logging_metric" "chat_turns" {
  project     = var.project_id
  name        = "chat_turns"
  description = "Chat turns served by the web app, by intent and outcome."
  filter      = "${local.web_log_filter} AND jsonPayload.event=\"chat_turn\""
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Chat turns"
    labels {
      key        = "intent"
      value_type = "STRING"
    }
    labels {
      key        = "outcome"
      value_type = "STRING"
    }
  }
  label_extractors = {
    intent  = "EXTRACT(jsonPayload.intent)"
    outcome = "EXTRACT(jsonPayload.outcome)"
  }
}

resource "google_logging_metric" "chat_turn_latency" {
  project         = var.project_id
  name            = "chat_turn_latency"
  description     = "End-to-end chat turn latency seen by the web app (ms), by intent."
  filter          = "${local.web_log_filter} AND jsonPayload.event=\"chat_turn\""
  value_extractor = "EXTRACT(jsonPayload.latency_ms)"
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "ms"
    display_name = "Chat turn latency"
    labels {
      key        = "intent"
      value_type = "STRING"
    }
  }
  label_extractors = {
    intent = "EXTRACT(jsonPayload.intent)"
  }
  # 100 ms .. ~40 min, ~40% wide buckets.
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 30
      growth_factor      = 1.4
      scale              = 100
    }
  }
}

resource "google_logging_metric" "web_errors" {
  project     = var.project_id
  name        = "web_errors"
  description = "Web app log entries with severity ERROR or higher, by event."
  filter      = "${local.web_log_filter} AND severity>=ERROR"
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Web errors"
    labels {
      key        = "event"
      value_type = "STRING"
    }
  }
  label_extractors = {
    event = "EXTRACT(jsonPayload.event)"
  }
}

resource "google_logging_metric" "agent_errors" {
  project     = var.project_id
  name        = "agent_errors"
  description = "Agent Runtime log entries with severity ERROR or higher."
  filter      = "${local.agent_log_filter} AND severity>=ERROR"
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Agent errors"
  }
}

resource "google_logging_metric" "gemini_rejections" {
  project     = var.project_id
  name        = "gemini_rejections"
  description = "Gemini requests rejected with 403 PERMISSION_DENIED, 429 RESOURCE_EXHAUSTED or a policy rejection, in agent or web logs."
  filter = join(" ", [
    "((${local.agent_log_filter}) OR (${local.web_log_filter}))",
    "AND (",
    "textPayload:\"Request rejected in accordance\" OR textPayload:\"403 PERMISSION_DENIED\" OR textPayload:\"429 RESOURCE_EXHAUSTED\"",
    "OR jsonPayload.message:\"Request rejected in accordance\" OR jsonPayload.message:\"403 PERMISSION_DENIED\" OR jsonPayload.message:\"429 RESOURCE_EXHAUSTED\"",
    "OR jsonPayload.error:\"Request rejected in accordance\" OR jsonPayload.error:\"403 PERMISSION_DENIED\" OR jsonPayload.error:\"429 RESOURCE_EXHAUSTED\"",
    ")",
  ])
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Gemini rejections"
  }
}

resource "google_logging_metric" "user_feedback" {
  project     = var.project_id
  name        = "user_feedback"
  description = "User feedback submissions, by rating and kind."
  filter      = "${local.web_log_filter} AND jsonPayload.event=\"user_feedback\""
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "User feedback"
    labels {
      key        = "rating"
      value_type = "STRING"
    }
    labels {
      key        = "kind"
      value_type = "STRING"
    }
  }
  label_extractors = {
    rating = "EXTRACT(jsonPayload.rating)"
    kind   = "EXTRACT(jsonPayload.kind)"
  }
}

resource "google_logging_metric" "sign_ins" {
  project     = var.project_id
  name        = "sign_ins"
  description = "Sign-in attempts, by outcome."
  filter      = "${local.web_log_filter} AND jsonPayload.event=\"sign_in\""
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Sign-ins"
    labels {
      key        = "outcome"
      value_type = "STRING"
    }
  }
  label_extractors = {
    outcome = "EXTRACT(jsonPayload.outcome)"
  }
}

resource "google_logging_metric" "rate_limited" {
  project     = var.project_id
  name        = "rate_limited"
  description = "Requests rejected by the per-user rate limiter, by scope."
  filter      = "${local.web_log_filter} AND jsonPayload.event=\"rate_limited\""
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Rate limited"
    labels {
      key        = "scope"
      value_type = "STRING"
    }
  }
  label_extractors = {
    scope = "EXTRACT(jsonPayload.scope)"
  }
}

resource "google_logging_metric" "ui_events" {
  project     = var.project_id
  name        = "ui_events"
  description = "Client UI events (onboarding funnel, tab views, quick actions), by name."
  filter      = "${local.web_log_filter} AND jsonPayload.event=\"ui_event\""
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "UI events"
    labels {
      key        = "name"
      value_type = "STRING"
    }
  }
  label_extractors = {
    name = "EXTRACT(jsonPayload.name)"
  }
}

# ---------------------------------------------------------------------------
# Alerting
# ---------------------------------------------------------------------------
resource "google_monitoring_notification_channel" "email" {
  count        = length(local.alert_email_list)
  project      = var.project_id
  display_name = "Fitness Buddy on-call email ${count.index + 1}"
  type         = "email"
  labels = {
    email_address = local.alert_email_list[count.index]
  }
  depends_on = [google_project_service.app_services]
}

resource "google_monitoring_uptime_check_config" "healthz" {
  count        = var.uptime_host == "" ? 0 : 1
  project      = var.project_id
  display_name = "Fitness Buddy uptime"
  period       = "300s"
  timeout      = "10s"

  http_check {
    path           = var.uptime_path
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.uptime_host
    }
  }
  depends_on = [google_project_service.app_services]
}

resource "google_monitoring_alert_policy" "uptime" {
  count                 = var.uptime_host == "" ? 0 : 1
  project               = var.project_id
  display_name          = "Fitness Buddy: site down (uptime check failing)"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Uptime check failing from more than one region for 10 min"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The public site has failed uptime checks for 10 minutes. Runbook: ${local.runbook_url}#site-down-uptime-check"
  }
}

resource "google_monitoring_alert_policy" "web_5xx_ratio" {
  project               = var.project_id
  display_name          = "Fitness Buddy: web 5xx ratio > 5%"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Cloud Run 5xx / all requests > 5% over 10 min"
    condition_threshold {
      filter             = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${local.web_service_name}\" AND metric.label.response_code_class=\"5xx\""
      denominator_filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${local.web_service_name}\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.05
      duration           = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "More than 5% of web requests returned 5xx over the last 10 minutes. Runbook: ${local.runbook_url}#cloud-run-5xx-ratio"
  }
}

resource "google_monitoring_alert_policy" "chat_latency_p95" {
  project               = var.project_id
  display_name          = "Fitness Buddy: chat turn p95 latency > 120 s"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "chat_turn_latency p95 > 120 s over 15 min"
    condition_threshold {
      filter          = "metric.type=\"${local.user_metric_prefix}/${google_logging_metric.chat_turn_latency.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 120000
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The 95th percentile chat turn latency exceeded 120 s over 15 minutes. Runbook: ${local.runbook_url}#slow-chat-turns"
  }
}

resource "google_monitoring_alert_policy" "agent_errors" {
  project               = var.project_id
  display_name          = "Fitness Buddy: agent errors > 5 in 10 min"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "agent_errors > 5 in 10 min"
    condition_threshold {
      filter          = "metric.type=\"${local.user_metric_prefix}/${google_logging_metric.agent_errors.name}\" AND resource.type=\"aiplatform.googleapis.com/ReasoningEngine\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The agent on Agent Runtime logged more than 5 ERROR entries in 10 minutes. Runbook: ${local.runbook_url}#agent-errors"
  }
}

resource "google_monitoring_alert_policy" "gemini_rejections" {
  project               = var.project_id
  display_name          = "Fitness Buddy: Gemini requests rejected"
  combiner              = "OR"
  notification_channels = local.notification_channels

  # Alert filters must name one resource type, so agent and web logs are
  # separate conditions (OR).
  dynamic "conditions" {
    for_each = {
      agent = "aiplatform.googleapis.com/ReasoningEngine"
      web   = "cloud_run_revision"
    }
    content {
      display_name = "gemini_rejections (${conditions.key}) > 0 in 5 min"
      condition_threshold {
        filter          = "metric.type=\"${local.user_metric_prefix}/${google_logging_metric.gemini_rejections.name}\" AND resource.type=\"${conditions.value}\""
        comparison      = "COMPARISON_GT"
        threshold_value = 0
        duration        = "0s"
        aggregations {
          alignment_period     = "300s"
          per_series_aligner   = "ALIGN_SUM"
          cross_series_reducer = "REDUCE_SUM"
        }
        trigger {
          count = 1
        }
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Gemini rejected requests (403 PERMISSION_DENIED, 429 RESOURCE_EXHAUSTED or a policy rejection). Users cannot chat. Runbook: ${local.runbook_url}#gemini-rejected-requests"
  }
}

resource "google_monitoring_alert_policy" "chat_failure_ratio" {
  project               = var.project_id
  display_name          = "Fitness Buddy: failed chat turns > 20%"
  combiner              = "OR"
  notification_channels = local.notification_channels

  # PromQL instead of a threshold ratio: ratio conditions are rejected until
  # both label series exist, and PromQL lets us require a minimum volume
  # (>= 3 turns in the window) so one failure at night does not page.
  conditions {
    display_name = "chat_turns with a failure outcome / all chat turns > 20% over 15 min"
    condition_prometheus_query_language {
      query               = <<-PROMQL
        (
          sum(increase(logging_googleapis_com:user_${google_logging_metric.chat_turns.name}{monitored_resource="cloud_run_revision",outcome!~"ok|awaiting_confirmation"}[15m]))
          /
          sum(increase(logging_googleapis_com:user_${google_logging_metric.chat_turns.name}{monitored_resource="cloud_run_revision"}[15m]))
        ) > 0.2
        and
        sum(increase(logging_googleapis_com:user_${google_logging_metric.chat_turns.name}{monitored_resource="cloud_run_revision"}[15m])) >= 3
      PROMQL
      duration            = "0s"
      evaluation_interval = "60s"
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "More than 20% of chat turns ended with an error outcome (agent_error / error) over 15 minutes. Runbook: ${local.runbook_url}#failed-chat-turns"
  }
}

# ---------------------------------------------------------------------------
# Usage dashboard (JSON template in dashboards/usage_dashboard.json.tftpl).
# ---------------------------------------------------------------------------
resource "google_monitoring_dashboard" "usage" {
  project = var.project_id
  dashboard_json = templatefile("${path.module}/dashboards/usage_dashboard.json.tftpl", {
    metric_prefix    = local.user_metric_prefix
    web_service_name = local.web_service_name
    agent_engine_id  = local.agent_engine_id
  })
  depends_on = [
    google_logging_metric.chat_turns,
    google_logging_metric.chat_turn_latency,
    google_logging_metric.web_errors,
    google_logging_metric.agent_errors,
    google_logging_metric.gemini_rejections,
    google_logging_metric.user_feedback,
    google_logging_metric.sign_ins,
    google_logging_metric.rate_limited,
    google_logging_metric.ui_events,
  ]
}

output "alert_notification_channels" {
  description = "Monitoring notification channel ids (used by the billing budget, see docs/OPERATIONS.md)."
  value       = local.notification_channels
}

output "usage_dashboard_id" {
  description = "Cloud Monitoring usage dashboard id."
  value       = google_monitoring_dashboard.usage.id
}

output "analytics_dataset" {
  description = "BigQuery dataset with usage events and reporting views."
  value       = google_bigquery_dataset.analytics.dataset_id
}
