#!/bin/bash
# Creates a self-signed code signing identity named "CmdPalm Self-Signed".
#
# CmdPalm is not signed with an Apple Developer ID. macOS remembers privacy
# permissions (Accessibility) by code signature, and ad-hoc signatures change
# on every build, so without a stable identity the permission has to be
# granted again after each update. A self-signed certificate keeps it stable.
#
#   scripts/make-signing-identity.sh            # add to the login keychain
#   scripts/make-signing-identity.sh --export   # also print CI secrets
#
# The release workflow imports the exported identity from the
# SIGNING_IDENTITY_P12 and SIGNING_IDENTITY_PASSWORD repository secrets.
set -euo pipefail

NAME="CmdPalm Self-Signed"
EXPORT=0
[[ "${1:-}" == "--export" ]] && EXPORT=1

if security find-identity -p codesigning | grep -q "\"$NAME\""; then
  echo "\"$NAME\" already exists in your keychain."
  if [[ $EXPORT == 0 ]]; then exit 0; fi
  echo "Export it from Keychain Access (File → Export Items, .p12) to set up CI." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat >"$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
O = CmdPalm
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 7300 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null
PASSWORD="$(openssl rand -base64 24)"
# macOS's importer only understands the older PKCS#12 algorithms.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
  -out "$WORK/identity.p12" -passout "pass:$PASSWORD"

security import "$WORK/identity.p12" -P "$PASSWORD" -T /usr/bin/codesign
echo "Added \"$NAME\" to your login keychain."
echo "macOS may ask to allow codesign to use the key the first time; choose Always Allow."

if [[ $EXPORT == 1 ]]; then
  echo
  echo "Repository secrets for the release workflow:"
  echo "SIGNING_IDENTITY_PASSWORD=$PASSWORD"
  echo "SIGNING_IDENTITY_P12=$(base64 -i "$WORK/identity.p12" | tr -d '\n')"
fi
