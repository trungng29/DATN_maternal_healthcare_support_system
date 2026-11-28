#!/bin/sh
set -eu

assistant_port="${RAG_ASSISTANT_PORT:-8000}"
case "$assistant_port" in
  *[!0-9]*|'' ) echo 'RAG_ASSISTANT_PORT must be a TCP port.' >&2; exit 1 ;;
esac
if ! [ "$assistant_port" -ge 1 ] || ! [ "$assistant_port" -le 65535 ]; then
  echo 'RAG_ASSISTANT_PORT must be between 1 and 65535.' >&2
  exit 1
fi
sed "s|http://host.docker.internal:8000|http://host.docker.internal:$assistant_port|" \
  /usr/local/kong/declarative/kong.yml >/tmp/kong-local.yml

# Bootstrap or migrate in place; never delete the persisted Kong volume.
if kong migrations list >/dev/null 2>&1; then
  kong migrations up
  kong migrations finish
else
  kong migrations bootstrap
fi
kong config db_import /tmp/kong-local.yml

# Provision the RS256 credential used by Kong's JWT plugin. Public key material
# is injected at runtime, not committed. Stable names make repeated imports safe.
: "${AUTH_JWT_PUBLIC_KEY:?AUTH_JWT_PUBLIC_KEY is required for Kong JWT verification}"
# A completed init container can be started again by Compose. Kong's db_export
# refuses to overwrite files left in that same container writable layer.
rm -f /tmp/kong-jwt.yml /tmp/kong-current.yml
cat > /tmp/kong-jwt.yml <<EOF
_format_version: "3.0"
consumers:
  - username: maternal-healthcare-auth
    jwt_secrets:
      - key: "${AUTH_JWT_ISSUER:-maternal-healthcare-auth}"
        algorithm: RS256
        secret: not-used-for-rs256
        rsa_public_key: |-
EOF
printf '%b
' "$AUTH_JWT_PUBLIC_KEY" | sed 's/^/          /' >> /tmp/kong-jwt.yml
kong config parse /tmp/kong-jwt.yml >/dev/null

# db_import is additive and rejects a repeated unique JWT key. Export first so
# rerunning Compose against an existing Kong volume remains idempotent.
kong config db_export /tmp/kong-current.yml >/dev/null
JWT_KEY="${AUTH_JWT_ISSUER:-maternal-healthcare-auth}"
if ! grep -Fq "key: $JWT_KEY" /tmp/kong-current.yml; then
  kong config db_import /tmp/kong-jwt.yml
fi
