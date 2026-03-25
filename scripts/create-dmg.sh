#!/bin/bash
set -e

APP_NAME="Vision Trigger Platform"
DMG_NAME="release/${APP_NAME}-1.0.0-arm64.dmg"
APP_PATH="release/mac-arm64/${APP_NAME}.app"
STAGING="release/dmg-staging"

# Clean up
rm -rf "$STAGING" "$DMG_NAME"
mkdir -p "$STAGING"

# Copy app and create Applications symlink
cp -R "$APP_PATH" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

# Create DMG
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -ov -format UDZO "$DMG_NAME"

# Clean up staging
rm -rf "$STAGING"

echo "DMG created: $DMG_NAME"
