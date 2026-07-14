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

# Cloud Shell ships a `terraform` STUB that only prints install instructions and
# does nothing (so `command -v terraform` lies). Always install the real binary
# into ~/bin and invoke it by absolute path via $TF so the stub can't shadow it.
TF="$HOME/bin/terraform"
if ! "$TF" version 2>/dev/null | grep -qiE '^Terraform v'; then
  bold "Installing Terraform (Cloud Shell only provides a stub)"
  TF_VER=1.9.8
  mkdir -p "$HOME/bin"
  curl -fsSL "https://releases.hashicorp.com/terraform/${TF_VER}/terraform_${TF_VER}_linux_amd64.zip" -o /tmp/atlas-tf.zip \
    && unzip -oq /tmp/atlas-tf.zip -d "$HOME/bin" \
    || die "failed to download/install Terraform"
fi
"$TF" version 2>/dev/null | grep -qiE '^Terraform v' || die "real terraform unavailable after install"
echo "Terraform: $("$TF" version | head -1)"

# First-time bootstrap: Terraform's google_project_service can't enable APIs
# until Cloud Resource Manager + Service Usage are already on (chicken-and-egg),
# so enable everything up front with gcloud. Idempotent; takes ~1-2 min.
bold "Enabling required Google APIs (first-time bootstrap)"
gcloud services enable \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  run.googleapis.com sqladmin.googleapis.com redis.googleapis.com \
  pubsub.googleapis.com bigquery.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com vpcaccess.googleapis.com iamcredentials.googleapis.com \
  cloudbuild.googleapis.com iam.googleapis.com \
  --project "${PROJECT_ID}" \
  || die "could not enable APIs — confirm billing is enabled on ${PROJECT_ID} and your account has Owner"

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

# Terraform reads all inputs from TF_VAR_* so `apply` and `import` agree.
export TF_VAR_project_id="${PROJECT_ID}"
export TF_VAR_region="${REGION}"

# Remote state bucket (idempotent) so state survives re-clones / disconnects.
bold "Ensuring Terraform state bucket gs://${PROJECT_ID}-tfstate"
gcloud storage buckets create "gs://${PROJECT_ID}-tfstate" \
  --location="${REGION}" --uniform-bucket-level-access >/dev/null 2>&1 || true

bold "Provisioning infrastructure (Terraform) — Cloud SQL is slow, ~10-15 min"
pushd deploy/gcp/terraform >/dev/null
[ -f terraform.tfvars ] || cp terraform.tfvars.example terraform.tfvars
"$TF" init -input=false -reconfigure >/dev/null || die "terraform init failed"

# Adopt any resources that already exist in the project (from earlier partial
# runs) into state, so apply reconciles instead of hitting 409 Already Exists.
# Tolerant: skips if already tracked, and no-ops if the object doesn't exist.
adopt() {
  "$TF" state list 2>/dev/null | grep -qxF "$1" && return 0
  "$TF" import -input=false "$1" "$2" >/dev/null 2>&1 || true
}
bold "Adopting any pre-existing resources into state"
P="${PROJECT_ID}"
adopt google_service_account.atlas_run    "projects/${P}/serviceAccounts/atlas-run@${P}.iam.gserviceaccount.com"
adopt google_service_account.github_deploy "projects/${P}/serviceAccounts/atlas-github-deploy@${P}.iam.gserviceaccount.com"
adopt google_storage_bucket.lake          "${P}-atlas-lake"
adopt google_bigquery_dataset.atlas       "projects/${P}/datasets/atlas_bi"
adopt google_artifact_registry_repository.atlas "projects/${P}/locations/${REGION}/repositories/atlas"
adopt google_redis_instance.atlas         "projects/${P}/locations/${REGION}/instances/atlas-redis"
adopt google_pubsub_topic.evidence        "projects/${P}/topics/atlas-evidence"
adopt google_pubsub_subscription.evidence_recompute "projects/${P}/subscriptions/atlas-evidence-recompute"
adopt google_vpc_access_connector.atlas   "projects/${P}/locations/${REGION}/connectors/atlas-connector"
adopt google_secret_manager_secret.database_url "projects/${P}/secrets/atlas-database-url"
adopt google_secret_manager_secret.redis_url    "projects/${P}/secrets/atlas-redis-url"
adopt google_iam_workload_identity_pool.github  "projects/${P}/locations/global/workloadIdentityPools/atlas-github"
adopt google_iam_workload_identity_pool_provider.github "projects/${P}/locations/global/workloadIdentityPools/atlas-github/providers/github-oidc"
adopt google_sql_database_instance.atlas  "${P}/atlas-pg"

# Apply. Retry once (API enablement / eventual consistency), then fail hard.
"$TF" apply -input=false -auto-approve \
  || { echo "retrying apply after transient errors..."; sleep 30; \
       "$TF" apply -input=false -auto-approve \
         || die "terraform apply failed — see the Error above"; }
WIF_PROVIDER="$("$TF" output -raw wif_provider 2>/dev/null || echo '')"
DEPLOY_SA="$("$TF" output -raw github_deploy_sa 2>/dev/null || echo '')"
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
