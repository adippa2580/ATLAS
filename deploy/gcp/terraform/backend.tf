# Remote state in GCS so Terraform state survives across machines / re-clones
# (the deploy script creates this bucket before `terraform init`).
terraform {
  backend "gcs" {
    bucket = "atlas-502319-tfstate"
    prefix = "atlas/state"
  }
}
