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

# Product analytics in BigQuery: a log sink routes the web app's structured
# usage events and the agent's tool outcomes to day-partitioned tables, and SQL
# views turn them into per-user usage, feedback, funnel and retention reports.
# Users are identified only by the pseudonym the web app logs (never an email).
# Ready-to-run queries: docs/OPERATIONS.md ("Product analytics").

variable "analytics_retention_days" {
  type        = number
  description = "Days of raw usage events kept in the analytics tables (partition expiration)."
  default     = 30
}

locals {
  analytics_web_events = [
    "chat_turn",
    "sign_in",
    "open_session",
    "user_feedback",
    "ui_event",
    "rate_limited",
    "account_export",
    "account_deleted",
    "agent_turn_exception",
    "dashboard_failed",
  ]

  # Table names are derived by Cloud Logging from the log names
  # (run.googleapis.com/stderr and aiplatform.googleapis.com/reasoning_engine_stderr).
  analytics_web_table   = "run_googleapis_com_stderr"
  analytics_agent_table = "aiplatform_googleapis_com_reasoning_engine_stderr"

  analytics_partition_ms = var.analytics_retention_days * 86400000

  analytics_sink_filter = join(" ", [
    "(${local.web_log_filter} AND jsonPayload.event=(${join(" OR ", [for e in local.analytics_web_events : "\"${e}\""])}))",
    "OR (${local.agent_log_filter} AND jsonPayload.event=\"tool_outcome\")",
  ])

  web_events_ref   = "`${var.project_id}.${google_bigquery_dataset.analytics.dataset_id}.${google_bigquery_table.analytics_web_events.table_id}`"
  agent_events_ref = "`${var.project_id}.${google_bigquery_dataset.analytics.dataset_id}.${google_bigquery_table.analytics_agent_events.table_id}`"

  # Chat turn outcomes that count as success (awaiting_confirmation = the agent
  # asked the user to confirm a write; not a failure).
  ok_outcomes_sql = "('ok', 'awaiting_confirmation')"

  analytics_views = {
    daily_active_users = {
      description = "Distinct active users (pseudonyms) and chat turns per day."
      query       = <<-SQL
        SELECT
          DATE(timestamp) AS day,
          COUNT(DISTINCT jsonPayload.user) AS active_users,
          COUNT(DISTINCT IF(jsonPayload.event = 'chat_turn', jsonPayload.user, NULL)) AS chatting_users,
          COUNTIF(jsonPayload.event = 'chat_turn') AS chat_turns
        FROM ${local.web_events_ref}
        WHERE jsonPayload.user IS NOT NULL
          AND jsonPayload.event != 'account_deleted'
        GROUP BY day
      SQL
    }

    turns_per_user_per_day = {
      description = "Chat turns, failures and average latency per user per day."
      query       = <<-SQL
        SELECT
          DATE(timestamp) AS day,
          jsonPayload.user AS user_pseudonym,
          COUNT(*) AS turns,
          COUNTIF(jsonPayload.outcome NOT IN ${local.ok_outcomes_sql}) AS failed_turns,
          ROUND(AVG(jsonPayload.latency_ms)) AS avg_latency_ms
        FROM ${local.web_events_ref}
        WHERE jsonPayload.event = 'chat_turn'
          AND jsonPayload.user IS NOT NULL
        GROUP BY day, user_pseudonym
      SQL
    }

    feature_usage = {
      description = "Daily usage per feature: chat intents, agent tools and UI events."
      query       = <<-SQL
        SELECT
          DATE(timestamp) AS day,
          'intent' AS source,
          jsonPayload.intent AS feature,
          COUNT(*) AS uses,
          COUNT(DISTINCT jsonPayload.user) AS distinct_users,
          COUNT(DISTINCT jsonPayload.session_id) AS distinct_sessions
        FROM ${local.web_events_ref}
        WHERE jsonPayload.event = 'chat_turn'
        GROUP BY day, feature
        UNION ALL
        SELECT
          DATE(timestamp) AS day,
          'ui' AS source,
          jsonPayload.name AS feature,
          COUNT(*) AS uses,
          COUNT(DISTINCT jsonPayload.user) AS distinct_users,
          CAST(NULL AS INT64) AS distinct_sessions
        FROM ${local.web_events_ref}
        WHERE jsonPayload.event = 'ui_event'
        GROUP BY day, feature
        UNION ALL
        SELECT
          DATE(timestamp) AS day,
          'tool' AS source,
          jsonPayload.tool AS feature,
          COUNT(*) AS uses,
          CAST(NULL AS INT64) AS distinct_users,
          COUNT(DISTINCT jsonPayload.session_id) AS distinct_sessions
        FROM ${local.agent_events_ref}
        WHERE jsonPayload.event = 'tool_outcome'
        GROUP BY day, feature
      SQL
    }

    latency_percentiles = {
      description = "Chat turn latency p50 / p95 / max (ms) by intent per day."
      query       = <<-SQL
        SELECT
          DATE(timestamp) AS day,
          jsonPayload.intent AS intent,
          COUNT(*) AS turns,
          APPROX_QUANTILES(jsonPayload.latency_ms, 100)[OFFSET(50)] AS p50_ms,
          APPROX_QUANTILES(jsonPayload.latency_ms, 100)[OFFSET(95)] AS p95_ms,
          MAX(jsonPayload.latency_ms) AS max_ms
        FROM ${local.web_events_ref}
        WHERE jsonPayload.event = 'chat_turn'
          AND jsonPayload.latency_ms IS NOT NULL
        GROUP BY day, intent
      SQL
    }

    error_rate = {
      description = "Daily chat turn failure rate and agent tool error rate."
      query       = <<-SQL
        WITH turn_stats AS (
          SELECT
            DATE(timestamp) AS day,
            COUNT(*) AS turns,
            COUNTIF(jsonPayload.outcome NOT IN ${local.ok_outcomes_sql}) AS failed_turns,
            COUNTIF(jsonPayload.outcome = 'agent_error') AS agent_error_turns,
            COUNTIF(jsonPayload.outcome = 'error') AS web_error_turns
          FROM ${local.web_events_ref}
          WHERE jsonPayload.event = 'chat_turn'
          GROUP BY day
        ),
        tool_stats AS (
          SELECT
            DATE(timestamp) AS day,
            COUNT(*) AS tool_calls,
            COUNTIF(jsonPayload.status != 'ok') AS tool_errors
          FROM ${local.agent_events_ref}
          WHERE jsonPayload.event = 'tool_outcome'
          GROUP BY day
        )
        SELECT
          day,
          IFNULL(t.turns, 0) AS turns,
          IFNULL(t.failed_turns, 0) AS failed_turns,
          IFNULL(t.agent_error_turns, 0) AS agent_error_turns,
          IFNULL(t.web_error_turns, 0) AS web_error_turns,
          SAFE_DIVIDE(t.failed_turns, t.turns) AS turn_failure_rate,
          IFNULL(s.tool_calls, 0) AS tool_calls,
          IFNULL(s.tool_errors, 0) AS tool_errors,
          SAFE_DIVIDE(s.tool_errors, s.tool_calls) AS tool_error_rate
        FROM turn_stats AS t
        FULL OUTER JOIN tool_stats AS s USING (day)
      SQL
    }

    feedback = {
      description = "User feedback events (rating, tags, comment flag) with their day."
      query       = <<-SQL
        SELECT
          DATE(timestamp) AS day,
          timestamp,
          jsonPayload.user AS user_pseudonym,
          jsonPayload.kind AS kind,
          jsonPayload.rating AS rating,
          jsonPayload.tags AS tags,
          jsonPayload.has_comment AS has_comment,
          jsonPayload.lang AS lang
        FROM ${local.web_events_ref}
        WHERE jsonPayload.event = 'user_feedback'
      SQL
    }

    onboarding_funnel = {
      description = "Daily onboarding funnel: distinct users who started, progressed and completed onboarding."
      query       = <<-SQL
        WITH ev AS (
          SELECT DATE(timestamp) AS day, jsonPayload.user AS u, jsonPayload.name AS n
          FROM ${local.web_events_ref}
          WHERE jsonPayload.event = 'ui_event'
            AND jsonPayload.name IN ('onboarding_start', 'onboarding_step', 'onboarding_complete')
        )
        SELECT
          day,
          COUNT(DISTINCT IF(n = 'onboarding_start', u, NULL)) AS started_users,
          COUNT(DISTINCT IF(n = 'onboarding_step', u, NULL)) AS step_users,
          COUNT(DISTINCT IF(n = 'onboarding_complete', u, NULL)) AS completed_users,
          SAFE_DIVIDE(
            COUNT(DISTINCT IF(n = 'onboarding_complete', u, NULL)),
            COUNT(DISTINCT IF(n = 'onboarding_start', u, NULL))
          ) AS completion_rate
        FROM ev
        GROUP BY day
      SQL
    }

    retention_d1_d7 = {
      description = "Cohorts by first-seen day: users active exactly 1 and 7 days later, and within days 1-7."
      query       = <<-SQL
        WITH activity AS (
          SELECT DISTINCT jsonPayload.user AS u, DATE(timestamp) AS d
          FROM ${local.web_events_ref}
          WHERE jsonPayload.user IS NOT NULL
            AND jsonPayload.event IN ('chat_turn', 'open_session', 'sign_in', 'ui_event', 'user_feedback')
        ),
        first_seen AS (
          SELECT u, MIN(d) AS first_day FROM activity GROUP BY u
        ),
        cohorts AS (
          SELECT
            f.first_day AS cohort_day,
            COUNT(DISTINCT f.u) AS cohort_users,
            COUNT(DISTINCT IF(a.d = DATE_ADD(f.first_day, INTERVAL 1 DAY), f.u, NULL)) AS d1_users,
            COUNT(DISTINCT IF(a.d = DATE_ADD(f.first_day, INTERVAL 7 DAY), f.u, NULL)) AS d7_users,
            COUNT(DISTINCT IF(a.d BETWEEN DATE_ADD(f.first_day, INTERVAL 1 DAY)
                                     AND DATE_ADD(f.first_day, INTERVAL 7 DAY), f.u, NULL)) AS active_d1_to_d7_users
          FROM first_seen AS f
          JOIN activity AS a USING (u)
          GROUP BY cohort_day
        )
        SELECT
          *,
          SAFE_DIVIDE(d1_users, cohort_users) AS d1_retention,
          SAFE_DIVIDE(d7_users, cohort_users) AS d7_retention,
          SAFE_DIVIDE(active_d1_to_d7_users, cohort_users) AS week1_retention
        FROM cohorts
      SQL
    }
  }
}

resource "google_bigquery_dataset" "analytics" {
  project       = var.project_id
  dataset_id    = replace("${var.project_name}_analytics", "-", "_")
  friendly_name = "${var.project_name} product analytics"
  location      = var.region
  description   = "Usage and feedback events routed from Cloud Logging (pseudonymous user ids), plus reporting views."
  depends_on    = [google_project_service.services]
}

# Tables are pre-created (day-partitioned on timestamp, as the sink expects) so
# the views below can be created before the first log entry arrives. The JSON
# schema files are only the INITIAL schema (the columns the views use plus the
# jsonPayload fields known today). Cloud Logging appends new columns as entries
# arrive, so ignore_changes on schema is required: without it Terraform would
# try to drop those columns or replace the table (losing the exported data).
resource "google_bigquery_table" "analytics_web_events" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = local.analytics_web_table
  description         = "Web app usage events (chat_turn, sign_in, user_feedback, ui_event, ...) from Cloud Logging."
  deletion_protection = true

  time_partitioning {
    type          = "DAY"
    field         = "timestamp"
    expiration_ms = local.analytics_partition_ms
  }

  schema = file("${path.module}/analytics/web_logs_schema.json")

  lifecycle {
    ignore_changes = [schema]
  }
}

resource "google_bigquery_table" "analytics_agent_events" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = local.analytics_agent_table
  description         = "Agent tool outcomes (tool, status, latency) from Cloud Logging."
  deletion_protection = true

  time_partitioning {
    type          = "DAY"
    field         = "timestamp"
    expiration_ms = local.analytics_partition_ms
  }

  schema = file("${path.module}/analytics/agent_logs_schema.json")

  lifecycle {
    ignore_changes = [schema]
  }
}

resource "google_logging_project_sink" "analytics" {
  name        = "${var.project_name}-analytics"
  project     = var.project_id
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.analytics.dataset_id}"
  description = "Usage events (web) and tool outcomes (agent) for product analytics."
  filter      = local.analytics_sink_filter

  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }

  depends_on = [
    google_bigquery_table.analytics_web_events,
    google_bigquery_table.analytics_agent_events,
  ]
}

resource "google_bigquery_dataset_iam_member" "analytics_sink_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.analytics.writer_identity
}

resource "google_bigquery_table" "analytics_views" {
  for_each            = local.analytics_views
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = each.key
  description         = each.value.description
  deletion_protection = false

  view {
    query          = each.value.query
    use_legacy_sql = false
  }
}
