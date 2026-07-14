# Runtime wiring for the Atlas Cloud Run service: DB user, secrets, service
# account, VPC connector, and required API enablement.

locals {
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "pubsub.googleapis.com",
    "bigquery.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "vpcaccess.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudbuild.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# --- DB user for the app ---
resource "google_sql_user" "atlas" {
  name     = "atlas"
  instance = google_sql_database_instance.atlas.name
  password = var.db_password
}

# --- Runtime service account for Cloud Run ---
resource "google_service_account" "atlas_run" {
  account_id   = "atlas-run"
  display_name = "Atlas Cloud Run runtime"
}

resource "google_project_iam_member" "run_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.atlas_run.email}"
}

resource "google_project_iam_member" "run_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.atlas_run.email}"
}

resource "google_project_iam_member" "run_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.atlas_run.email}"
}

# --- Secrets: DATABASE_URL (via Cloud SQL connector socket) and REDIS_URL ---
resource "google_secret_manager_secret" "database_url" {
  secret_id = "atlas-database-url"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # Cloud Run connects to Cloud SQL over a unix socket at /cloudsql/<connName>.
  secret_data = "postgresql://atlas:${var.db_password}@localhost/atlas?host=/cloudsql/${google_sql_database_instance.atlas.connection_name}"
}

resource "google_secret_manager_secret" "redis_url" {
  secret_id = "atlas-redis-url"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "redis_url" {
  secret      = google_secret_manager_secret.redis_url.id
  secret_data = "redis://${google_redis_instance.atlas.host}:${google_redis_instance.atlas.port}"
}

# --- Serverless VPC connector for private Cloud SQL / Memorystore egress ---
resource "google_vpc_access_connector" "atlas" {
  name          = "atlas-connector"
  region        = var.region
  network       = "default"
  ip_cidr_range = "10.8.0.0/28"
}

output "run_service_account" { value = google_service_account.atlas_run.email }
output "sql_connection_name" { value = google_sql_database_instance.atlas.connection_name }
