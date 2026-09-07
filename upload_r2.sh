#!/usr/bin/env sh
# upload_r2.sh — push the tiles/ folder to a Cloudflare R2 bucket.
#
# R2 speaks the S3 API, so the ordinary AWS CLI works. One-time setup:
#   1. Cloudflare dashboard -> R2 -> Create bucket (e.g. "familiarizer-tiles").
#   2. R2 -> Manage R2 API Tokens -> create a token with Object Read & Write.
#   3. Bucket -> Settings -> Public access -> enable r2.dev subdomain (or attach a domain).
#      The phone will fetch  https://<public host>/14/<x>/<y>.json
#   4. Bucket -> Settings -> CORS policy -> paste the JSON below so the web app
#      (served from a different origin) is allowed to fetch tiles:
#        [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400}]
#   5. pip install awscli   (or brew/apt)
#
# Then:
#   export R2_ACCOUNT_ID=...  R2_BUCKET=familiarizer-tiles
#   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
#   sh upload_r2.sh [tiles]
#
# `sync` only uploads files that changed, so re-running after salience_pass.py
# moves just the tiles it touched.
set -eu
SRC="${1:-tiles}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"

aws s3 sync "$SRC" "s3://$R2_BUCKET/" \
  --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
  --region auto \
  --content-type application/json \
  --cache-control "public, max-age=86400" \
  --exclude "*" --include "*.json"

echo "done: s3://$R2_BUCKET  (public URL: your bucket's r2.dev host or custom domain)"
