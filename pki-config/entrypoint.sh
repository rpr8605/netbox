# pki-config/entrypoint.sh
# Bring up step-ca with deterministic CA material. `step ca init` hard-requires
# a TTY even with --password-file (verified in this repo's setup), so root and
# intermediate material is generated with the non-interactive
# `step certificate create` path instead. DEV ONLY: keys are unencrypted
# (--no-password --insecure); production CA material must be passphrase-protected
# and ideally held outside the online container entirely (offline root).
set -e
STEPPATH="${STEPPATH:-/home/step}"
mkdir -p "$STEPPATH/certs" "$STEPPATH/secrets" "$STEPPATH/db"
if [ ! -f "$STEPPATH/certs/root_ca.crt" ]; then
  step certificate create --no-password --insecure --profile root-ca \
    "Netbox Demo Root CA" \
    "$STEPPATH/certs/root_ca.crt" "$STEPPATH/secrets/root_ca_key"
  step certificate create --no-password --insecure --profile intermediate-ca \
    --ca "$STEPPATH/certs/root_ca.crt" --ca-key "$STEPPATH/secrets/root_ca_key" \
    "Netbox Demo Intermediate CA" \
    "$STEPPATH/certs/intermediate_ca.crt" "$STEPPATH/secrets/intermediate_ca_key"
  echo "step-ca: root + intermediate CA material generated"
fi
exec step-ca /home/step/config/ca.json
