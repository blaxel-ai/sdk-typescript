#!/bin/bash
set -e

# Use BL_ENV if set, default to prod
if [ "$BL_ENV" = "dev" ]; then
  WORKSPACE="charlou-dev"
  REGION="eu-dub-1"
else
  WORKSPACE="main"
  REGION="us-pdx-1"
fi

TOKEN=$(BL_ENV=$BL_ENV bl token)
API_BASE="https://api.blaxel.dev/v0"

# Use provided names or generate new ones
DRIVE_NAME="${1:-test-drive-$(date +%s)}"
SANDBOX_NAME="${2:-test-sbx-$(date +%s)}"

echo "=== Testing Drive Attach ==="
echo "Environment: $BL_ENV (Workspace: $WORKSPACE, Region: $REGION)"
echo "Drive: $DRIVE_NAME"
echo "Sandbox: $SANDBOX_NAME"
echo ""

# Create drive
echo "1. Creating drive..."
DRIVE_RESP=$(curl -s -X POST "$API_BASE/drives" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Blaxel-Workspace: $WORKSPACE" \
  -H "Content-Type: application/json" \
  -d "{
    \"metadata\": {\"name\": \"$DRIVE_NAME\"},
    \"spec\": {\"size\": 10, \"region\": \"$REGION\"}
  }")

DRIVE_STATUS=$(echo "$DRIVE_RESP" | jq -r '.metadata.name // .error // "ERROR"')
if [ "$DRIVE_STATUS" = "ERROR" ] || echo "$DRIVE_RESP" | jq -e '.error' > /dev/null 2>&1; then
  echo "❌ Failed to create drive:"
  echo "$DRIVE_RESP" | jq .
  exit 1
fi
echo "✅ Drive created: $DRIVE_STATUS"

# Create sandbox
echo ""
echo "2. Creating sandbox..."
SANDBOX_RESP=$(curl -s -X POST "$API_BASE/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Blaxel-Workspace: $WORKSPACE" \
  -H "Content-Type: application/json" \
  -d "{
    \"metadata\": {\"name\": \"$SANDBOX_NAME\"},
    \"spec\": {
      \"runtime\": {\"image\": \"blaxel/base-image:latest\", \"memory\": 2048},
      \"region\": \"$REGION\"
    }
  }")

SANDBOX_URL=$(echo "$SANDBOX_RESP" | jq -r '.metadata.url // empty')
if [ -z "$SANDBOX_URL" ]; then
  echo "❌ Failed to create sandbox:"
  echo "$SANDBOX_RESP" | jq .
  exit 1
fi
echo "✅ Sandbox created: $SANDBOX_URL"

# Attach drive
echo ""
echo "3. Attaching drive to sandbox at /mnt/test..."
ATTACH_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  "$SANDBOX_URL/drives/mount" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"driveName\": \"$DRIVE_NAME\",
    \"mountPath\": \"/mnt/test\",
    \"drivePath\": \"/\"
  }")

ATTACH_CODE=$(echo "$ATTACH_RESP" | tail -n 1)
ATTACH_BODY=$(echo "$ATTACH_RESP" | sed '$d')

echo "Status: $ATTACH_CODE"
if [ "$ATTACH_CODE" = "200" ]; then
  echo "✅ Attach succeeded!"
  echo "$ATTACH_BODY" | jq .
else
  echo "❌ Attach failed!"
  echo "$ATTACH_BODY" | jq .
fi

# List mounts
echo ""
echo "4. Listing mounted drives..."
LIST_RESP=$(curl -s "$SANDBOX_URL/drives/mount" -H "Authorization: Bearer $TOKEN")
echo "$LIST_RESP" | jq .
