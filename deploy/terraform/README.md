<!-- TEMPLATE — not applied or validated against a live environment. -->
# Terraform skeleton

**Nothing here has been applied, planned, or validated** (`terraform` was not even
available when this was written). It is a provider-agnostic outline.

TODO modules: network (VPC), managed Postgres 16, managed Redis 7, Kubernetes
cluster (with a NetworkPolicy-enforcing CNI), secrets/KMS for signer key_refs.

Before use: pick a provider, pin versions, configure remote state with locking,
write the modules, run `terraform validate` and `plan` in a non-production
account. Apply `../schema.sql` through your migration tooling.
