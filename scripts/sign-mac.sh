#!/bin/bash
# Re-sign the built app with consistent ad-hoc identity + camera entitlements
set -e

APP="$1"
ENTITLEMENTS="entitlements.mac.plist"

if [ ! -d "$APP" ]; then
  echo "Error: $APP not found"
  exit 1
fi

echo "Signing frameworks..."
find "$APP/Contents/Frameworks" -name "*.framework" | while read fw; do
  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$fw"
done

echo "Signing helpers..."
find "$APP/Contents/Frameworks" -name "*.app" -maxdepth 1 | while read helper; do
  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$helper"
done

# Sign Python backend binaries if bundled
if [ -d "$APP/Contents/Resources/python-backend" ]; then
  echo "Signing Python backend..."
  find "$APP/Contents/Resources/python-backend" -type f -perm +111 | while read bin; do
    codesign --force --sign - --entitlements "$ENTITLEMENTS" "$bin" 2>/dev/null || true
  done
fi

echo "Signing main app..."
codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --deep --strict "$APP"
echo "Signing complete and verified."
