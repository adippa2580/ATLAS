#!/usr/bin/env bash
#
# One-shot Atlas deploy for Google Cloud Shell.
# Run from the repo root:  ./deploy/gcp/cloudshell-deploy.sh
#
# Cloud Shell already has gcloud + terraform and authenticates you to Google, so
# no service-account key is needed. This script:
#   1. enables APIs + provisions infra (Terraform)
#   2. builds the image via Cloud Build (no local Docker needed)
#   3. runs DB migrations as a Cloud Run Job
#   4. deploys the Cloud Run service and prints the URL
# It is idempotent — safe to re-run if a step fails.
set -uo pipefail
# Surface non-zero exits instead of dying silently (each critical step also
# calls die() with a specific message).
trap 'rc=$?; [ "$rc" -ne 0 ] && echo -e "\n!! deploy exited with code ${rc} — see the last message above." >&2' EXIT

PROJECT_ID="${PROJECT_ID:-atlas-502319}"
REGION="${REGION:-us-central1}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Fail fast on real errors, but NOT on gcloud's benign non-zero exits (e.g. the
# "Regional Access Boundary / Gaia id not found" warning some Workspace accounts
# emit) — those must not abort the deploy.
die() { echo -e "\n!! $*" >&2; exit 1; }

bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

bold "Project ${PROJECT_ID} / region ${REGION}"
export CLOUDSDK_CORE_PROJECT="${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}" >/dev/null 2>&1 || true

# Cloud Shell no longer ships Terraform — install a pinned binary into ~/bin if
# it's missing, so this script is self-contained.
if ! command -v terraform >/dev/null 2>&1; then
  bold "Installing Terraform (not present in this environment)"
  TF_VER=1.9.8
  mkdir -p "$HOME/bin"
  curl -fsSL "https://releases.hashicorp.com/terraform/${TF_VER}/terraform_${TF_VER}_linux_amd64.zip" -o /tmp/atlas-tf.zip \
    && unzip -oq /tmp/atlas-tf.zip -d "$HOME/bin" \
    || die "failed to download/install Terraform"
  export PATH="$HOME/bin:$PATH"
fi
command -v terraform >/dev/null 2>&1 || die "terraform not found after install attempt"
echo "Terraform: $(terraform version | head -1)"

# --- DB password: reuse if already in Secret Manager, else generate + keep ---
if [ -z "${TF_VAR_db_password:-}" ]; then
  if gcloud secrets versions access latest --secret=atlas-db-password >/dev/null 2>&1; then
    export TF_VAR_db_password="$(gcloud secrets versions access latest --secret=atlas-db-password)"
    echo "Reusing existing DB password from Secret Manager."
  else
    export TF_VAR_db_password="$(openssl rand -hex 16)"
    echo "Generated a new DB password (stored in Secret Manager as atlas-db-password)."
  fi
fi

bold "Provisioning infrastructure (Terraform) — Cloud SQL is slow, ~10-15 min"
pushd deploy/gcp/terraform >/dev/null
[ -f terraform.tfvars ] || cp terraform.tfvars.example terraform.tfvars
terraform init -input=false >/dev/null || die "terraform init failed"
# First apply can race API enablement; retry once, then fail hard.
terraform apply -input=false -auto-approve \
  -var="project_id=${PROJECT_ID}" -var="region=${REGION}" \
  || { echo "retrying apply after API enablement..."; sleep 20; \
       terraform apply -input=false -auto-approve \
         -var="project_id=${PROJECT_ID}" -var="region=${REGION}" \
         || die "terraform apply failed — see the Error above (usually a missing role or unenabled API)"; }
WIF_PROVIDER="$(terraform output -raw wif_provider 2>/dev/null || echo '')"
DEPLOY_SA="$(terraform output -raw github_deploy_sa 2>/dev/null || echo '')"
popd >/dev/null

# Stash the DB password so re-runs reuse it.
if ! gcloud secrets describe atlas-db-password >/dev/null 2>&1; then
  printf '%s' "${TF_VAR_db_password}" | gcloud secrets create atlas-db-password --data-file=- >/dev/null
fi

IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo latest)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/atlas/atlas:${IMAGE_TAG}"

bold "Building image via Cloud Build: ${IMAGE}"
gcloud builds submit --tag "${IMAGE}" . || die "Cloud Build failed — see the build log above"

bold "Resolving Cloud SQL connection name"
SQL_CONN="$(gcloud sql instances describe atlas-pg --format='value(connectionName)')"
[ -n "${SQL_CONN}" ] || die "could not resolve Cloud SQL connection name (did terraform create atlas-pg?)"

bold "Running database migrations (Cloud Run Job: prisma migrate deploy)"
gcloud run jobs deploy atlas-migrate \
  --image "${IMAGE}" --region "${REGION}" \
  --service-account "atlas-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-cloudsql-instances "${SQL_CONN}" \
  --set-secrets "DATABASE_URL=atlas-database-url:latest" \
  --command npx --args "prisma,migrate,deploy" --quiet || die "creating migrate job failed"
gcloud run jobs execute atlas-migrate --region "${REGION}" --wait || die "database migration failed"

bold "Deploying Cloud Run service"
TMP="$(mktemp)"
sed -e "s/__REGION__/${REGION}/g" \
    -e "s/__PROJECT_ID__/${PROJECT_ID}/g" \
    -e "s/__IMAGE_TAG__/${IMAGE_TAG}/g" \
    -e "s#__SQL_CONNECTION_NAME__#${SQL_CONN}#g" \
    deploy/gcp/cloudrun.yaml > "${TMP}"
gcloud run services replace "${TMP}" --region "${REGION}" || die "Cloud Run deploy failed"
rm -f "${TMP}"

# Public access for a first look — restrict for a real environment.
gcloud run services add-iam-policy-binding atlas \
  --region "${REGION}" --member=allUsers --role=roles/run.invoker -q || true

URL="$(gcloud run services describe atlas --region "${REGION}" --format='value(status.url)')"

bold "DONE"
echo "  Service : ${URL}"
echo "  Health  : ${URL}/health"
echo "  API docs: ${URL}/docs"
echo
echo "  For auto-deploy on push to main, set these GitHub repo Variables:"
echo "    GCP_PROJECT_ID   = ${PROJECT_ID}"
echo "    GCP_REGION       = ${REGION}"
echo "    GCP_WIF_PROVIDER = ${WIF_PROVIDER}"
echo "    GCP_DEPLOY_SA    = ${DEPLOY_SA}"
echo
echo "  Smoke test:"
echo "    curl -s ${URL}/health   # expect {\"status\":\"ok\",\"db\":\"up\"}"
