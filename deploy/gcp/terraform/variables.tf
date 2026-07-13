variable "project_id" {
  type        = string
  default     = "atlas-502319"
  description = "GCP project ID to deploy into."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP region for all regional resources."
}

variable "github_repo" {
  type        = string
  default     = "adippa2580/ATLAS"
  description = "owner/repo allowed to deploy via Workload Identity Federation."
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Password for the atlas Postgres user. Pass via TF_VAR_db_password."
}
