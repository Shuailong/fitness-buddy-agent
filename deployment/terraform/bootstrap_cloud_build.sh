#!/usr/bin/env bash
# One-time bootstrap for running Terraform on Cloud Build in a fresh project.
#
# Creates: required bootstrap APIs, a versioned GCS bucket for Terraform state,
# and the `terraform-runner` service account used by deployment/terraform/cloudbuild.yaml.
#
# Usage: deployment/terraform/bootstrap_cloud_build.sh <project-id> [region]
set -euo pipefail

PROJECT_ID="${1:?usage: $0 <project-id> [region]}"
REGION="${2:-us-east1}"
STATE_BUCKET="${PROJECT_ID}-tfstate"
RUNNER="terraform-runner@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Enabling bootstrap APIs..."
gcloud services enable --project "$PROJECT_ID" \
  serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  cloudbuild.googleapis.com storage.googleapis.com iam.googleapis.com \
  logging.googleapis.com

echo "Creating state bucket gs://${STATE_BUCKET} (versioned)..."
if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${STATE_BUCKET}" --project "$PROJECT_ID" \
    --location "$REGION" --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning

echo "Creating service account ${RUNNER}..."
if ! gcloud iam service-accounts describe "$RUNNER" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create terraform-runner --project "$PROJECT_ID" \
    --display-name "Terraform runner (Cloud Build)"
fi

# New service accounts take a few seconds to become visible to IAM policies.
for _ in $(seq 1 12); do
  gcloud iam service-accounts describe "$RUNNER" --project "$PROJECT_ID" >/dev/null 2>&1 && break
  sleep 5
done

bind_with_retry() {
  for attempt in 1 2 3 4 5 6; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    echo "  binding not ready yet (attempt ${attempt}); retrying in 10s..."
    sleep 10
  done
  "$@"  # final attempt shows the error
}

# Roles Terraform needs to manage this stack (APIs, IAM, Firestore, Secret
# Manager, Model Armor, WIF, Cloud Run, Agent Runtime).
for ROLE in roles/editor roles/resourcemanager.projectIamAdmin roles/secretmanager.admin \
            roles/iam.workloadIdentityPoolAdmin roles/modelarmor.admin roles/serviceusage.serviceUsageAdmin \
            roles/logging.logWriter roles/logging.configWriter roles/iam.serviceAccountAdmin \
            roles/run.admin roles/datastore.owner roles/bigquery.connectionAdmin; do
  bind_with_retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --quiet --condition=None \
    --member "serviceAccount:${RUNNER}" --role "$ROLE"
done
bind_with_retry gcloud storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" \
  --member "serviceAccount:${RUNNER}" --role roles/storage.objectAdmin

echo "Done. Next:"
echo "  gcloud builds submit --project ${PROJECT_ID} --config deployment/terraform/cloudbuild.yaml \\"
echo "    --substitutions=_STATE_BUCKET=${STATE_BUCKET},_REGION=${REGION}"
