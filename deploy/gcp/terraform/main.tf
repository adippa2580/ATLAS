# Atlas — GCP infrastructure (skeleton).
# Maps the three planes from docs/architecture/atlas-system-design.md onto GCP:
#   transactional -> Cloud SQL (Postgres)  | evidence -> Pub/Sub + GCS lake
#   intelligence  -> BigQuery              | serving  -> Memorystore (Redis), Cloud Run
#
# This is a starting point, not a turnkey apply. Fill in project/region and review
# networking before use.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- Transactional plane: Cloud SQL (Postgres) ---
resource "google_sql_database_instance" "atlas" {
  name             = "atlas-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  settings {
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL" # multi-AZ failover
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    ip_configuration {
      ipv4_enabled = false
      # private_network = google_compute_network.atlas.id
    }
  }
  deletion_protection = true
}

resource "google_sql_database" "atlas" {
  name     = "atlas"
  instance = google_sql_database_instance.atlas.name
}

# --- Serving plane: Memorystore (Redis) ---
resource "google_redis_instance" "atlas" {
  name           = "atlas-redis"
  tier           = "STANDARD_HA"
  memory_size_gb = 1
  region         = var.region
}

# --- Evidence plane: Pub/Sub topic + subscription for the recompute worker ---
resource "google_pubsub_topic" "evidence" {
  name = "atlas-evidence"
}

resource "google_pubsub_subscription" "evidence_recompute" {
  name  = "atlas-evidence-recompute"
  topic = google_pubsub_topic.evidence.name
  ack_deadline_seconds = 30
  retry_policy {
    minimum_backoff = "5s"
  }
}

# --- Evidence lake: GCS bucket (Parquet/Iceberg) ---
resource "google_storage_bucket" "lake" {
  name                        = "${var.project_id}-atlas-lake"
  location                    = var.region
  uniform_bucket_level_access = true
}

# --- Intelligence plane: BigQuery dataset for venue BI ---
resource "google_bigquery_dataset" "atlas" {
  dataset_id = "atlas_bi"
  location   = var.region
}

# --- Artifact Registry for the container image ---
resource "google_artifact_registry_repository" "atlas" {
  repository_id = "atlas"
  format        = "DOCKER"
  location      = var.region
}

output "sql_instance" { value = google_sql_database_instance.atlas.name }
output "redis_host" { value = google_redis_instance.atlas.host }
output "evidence_topic" { value = google_pubsub_topic.evidence.name }
