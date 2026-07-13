#!/usr/bin/env bash
# Manual deploy of the Atlas monolith to Cloud Run.
# Prereqs: gcloud authenticated (gcloud auth login), Docker, and Terraform applied
# once (see deploy/gcp/README.md). Idempotent — safe to re-run.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-atlas-502319}"
REGION="${REGION:-us-central1}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
REPO="atlas"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/atlas:${IMAGE_TAG}"

echo "==> Project ${PROJECT_ID}  Region ${REGION}  Image ${IMAGE}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Building and pushing image"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" -q
docker build -t "${IMAGE}" .
docker push "${IMAGE}"

echo "==> Resolving Cloud SQL connection name"
SQL_CONN="$(gcloud sql instances describe atlas-pg --format='value(connectionName)')"

echo "==> Running database migrations (Cloud Run job)"
# One-off job that runs `prisma migrate deploy` against Cloud SQL, then exits.
gcloud run jobs deploy atlas-migrate \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --service-account "atlas-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-cloudsql-instances "${SQL_CONN}" \
  --set-secrets "DATABASE_URL=atlas-database-url:latest" \
  --command npx --args "prisma,migrate,deploy" \
  --quiet
gcloud run jobs execute atlas-migrate --region "${REGION}" --wait

echo "==> Deploying Cloud Run service"
TMP="$(mktemp)"
sed -e "s/__REGION__/${REGION}/g" \
    -e "s/__PROJECT_ID__/${PROJECT_ID}/g" \
    -e "s/__IMAGE_TAG__/${IMAGE_TAG}/g" \
    -e "s#__SQL_CONNECTION_NAME__#${SQL_CONN}#g" \
    deploy/gcp/cloudrun.yaml > "${TMP}"
gcloud run services replace "${TMP}" --region "${REGION}"
rm -f "${TMP}"

echo "==> Allowing unauthenticated access (adjust to taste)"
gcloud run services add-iam-policy-binding atlas \
  --region "${REGION}" --member=allUsers --role=roles/run.invoker -q || true

URL="$(gcloud run services describe atlas --region "${REGION}" --format='value(status.url)')"
echo "==> Deployed: ${URL}"
echo "    Health:   ${URL}/health"
echo "    Docs:     ${URL}/docs"
