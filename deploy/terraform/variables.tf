# TEMPLATE — not applied or validated against a live environment.
# Placeholder variables; no defaults carry real values, domains or credentials.

variable "name" {
  type        = string
  description = "Name prefix for all resources."
}

variable "vpc_cidr" {
  type        = string
  description = "TODO: CIDR for the network."
}

variable "postgres_instance_class" {
  type        = string
  description = "TODO: provider-specific instance size."
}

variable "redis_node_type" {
  type        = string
  description = "TODO: provider-specific node size."
}

variable "k8s_node_count" {
  type        = number
  description = "TODO: worker node count."
  default     = 3
}
