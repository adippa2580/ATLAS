# Deploying Atlas to GCP (project `atlas-502319`)

The Atlas monolith runs on **Cloud Run**, backed by **Cloud SQL (Postgres)**,
**Memorystore (Redis)**, **Pub/Sub** (evidence stream), **BigQuery** (BI), and
**GCS** (evidence lake). Infrastructure is Terraform; the image ships to
**Artifact Registry**; deploys run via `deploy.sh` or the GitHub Actions
`Deploy (Cloud Run)` workflow (keyless, via Workload Identity Federation).

> You run the commands (they need your GCP credentials); this repo provides
> everything parameterized. Region defaults to `us-central1` — change with
> `REGION=...` / the `region` tfvar.

## One-time setup

```bash
# 0. Authenticate
gcloud auth login
gcloud auth application-default login
gcloud config set project atlas-502319

# 1. Provision infrastructure
cd deploy/gcp/terraform
cp terraform.tfvars.example terraform.tfvars      # project_id/region prefilled
export TF_VAR_db_password='<choose-a-strong-password>'
terraform init
terraform apply                                    # creates SQL, Redis, Pub/Sub,
                                                   # BigQuery, GCS, Artifact Registry,
                                                   # secrets, VPC connector, WIF
```

Terraform outputs you'll need for CI:
- `wif_provider`      → GitHub repo variable `GCP_WIF_PROVIDER`
- `github_deploy_sa`  → GitHub repo variable `GCP_DEPLOY_SA`
- plus set `GCP_PROJECT_ID=atlas-502319` and `GCP_REGION=us-central1`

## Deploy

**One-shot from Google Cloud Shell (recommended — no key, no local Docker):**
```bash
# in Cloud Shell (shell.cloud.google.com)
git clone https://github.com/adippa2580/ATLAS.git && cd ATLAS
git checkout claude/system-design-wt0pcw
./deploy/gcp/cloudshell-deploy.sh   # terraform apply -> Cloud Build -> migrate -> deploy
```
This chains everything: it generates + stores a DB password, provisions infra,
builds the image with Cloud Build, runs migrations as a Cloud Run Job, deploys
the service, and prints the URL plus the four GitHub variables for CI/CD. Safe
to re-run.

**Manual (local, needs Docker):**
```bash
cd <repo root>
./deploy/gcp/deploy.sh            # builds+pushes image, runs migrations, deploys
```

**CI/CD:** push to `main` → the `Deploy (Cloud Run)` workflow authenticates via
WIF, builds/pushes the image, runs `prisma migrate deploy` as a Cloud Run Job,
then replaces the service. Requires the four repo variables above.

## What happens on deploy

1. Image built from the root `Dockerfile` and pushed to Artifact Registry.
2. **Migrations:** a one-off Cloud Run Job runs `prisma migrate deploy` against
   Cloud SQL (migration in `prisma/migrations/0001_init`).
3. **Service:** `cloudrun.yaml` rendered (region/project/tag/SQL-connection
   substituted) and applied. `EVIDENCE_BUS=pubsub` switches the evidence bus off
   the in-memory dev implementation; `DATABASE_URL`/`REDIS_URL` come from Secret
   Manager; Cloud SQL is reached over the mounted socket.

## Notes

- Connector credentials (Stripe/Spotify/Instagram/Klaviyo/Square) are unset →
  adapters stay in **stub mode**. Add them as Secret Manager secrets and wire
  into `cloudrun.yaml` env when going live.
- The in-process recompute worker still runs inside the service; to scale it out,
  move it to a dedicated Pub/Sub push subscription (the `EvidenceBus` abstraction
  already supports it).
- `allUsers` invoker is granted for convenience — restrict for a real environment.
