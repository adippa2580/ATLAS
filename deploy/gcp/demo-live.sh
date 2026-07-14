#!/usr/bin/env bash
# Prepare the live Atlas deployment for a demo:
#   1. build a fresh image (includes prisma/seed.mjs)
#   2. seed a demo tenant/guest/venue via a Cloud Run Job (fixed IDs)
#   3. enable header-based auth on the service (DEV_TRUST_HEADERS=true) so the
#      scoped endpoints can be driven without full OAuth
# Demo only — turn header-auth back off afterward for a locked-down prod.
set -uo pipefail
PROJECT_ID="${PROJECT_ID:-atlas-502319}"
REGION="${REGION:-us-central1}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo demo)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/atlas/atlas:${IMAGE_TAG}"

echo "==> Building image ${IMAGE}"
gcloud builds submit --tag "$IMAGE" . || { echo "build failed"; exit 1; }

SQL_CONN="$(gcloud sql instances describe atlas-pg --format='value(connectionName)')"

echo "==> Seeding demo data (Cloud Run Job)"
gcloud run jobs deploy atlas-seed --image "$IMAGE" --region "$REGION" \
  --service-account "atlas-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-cloudsql-instances "$SQL_CONN" \
  --set-secrets "DATABASE_URL=atlas-database-url:latest" \
  --command node --args "prisma/seed.mjs" --quiet
gcloud run jobs execute atlas-seed --region "$REGION" --wait

echo "==> Enabling header-auth on the service (demo only)"
gcloud run services update atlas --region "$REGION" \
  --update-env-vars DEV_TRUST_HEADERS=true --quiet

URL="$(gcloud run services describe atlas --region "$REGION" --format='value(status.url)')"
echo "==> DEMO READY"
echo "  Service: ${URL}"
echo "  (to lock down again: gcloud run services update atlas --region ${REGION} --update-env-vars DEV_TRUST_HEADERS=false)"
