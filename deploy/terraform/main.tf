# TEMPLATE — not applied or validated against a live environment.
# NOTHING in this directory has been run through `terraform init/validate/plan/apply`.
# Skeleton only: every module is a TODO placeholder with no provider chosen.

terraform {
  required_version = ">= 1.5"
  # TODO: choose provider(s) and pin versions.
  # required_providers { ... }
  # TODO: configure a remote state backend with locking.
  # backend "..." {}
}

# TODO: provider "..." {}

# TODO module "network" — VPC / private subnets / egress controls.
# module "network" {
#   source = "./modules/network"   # does not exist yet
#   name   = var.name
#   cidr   = var.vpc_cidr
# }

# TODO module "postgres" — managed Postgres 16, private only, PITR backups.
# Apply deploy/schema.sql via your migration process, not Terraform.
# module "postgres" {
#   source         = "./modules/postgres"
#   name           = var.name
#   instance_class = var.postgres_instance_class
# }

# TODO module "redis" — managed Redis 7, private only.
# module "redis" {
#   source    = "./modules/redis"
#   name      = var.name
#   node_type = var.redis_node_type
# }

# TODO module "kubernetes" — K8s cluster with NetworkPolicy-enforcing CNI
# (required for the signer isolation policy in the Helm chart).
# module "kubernetes" {
#   source     = "./modules/kubernetes"
#   name       = var.name
#   node_count = var.k8s_node_count
# }

# TODO: secrets manager / KMS for signer key material (key_ref targets).
