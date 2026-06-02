#!/bin/bash
# One-shot Apps Script deploy.
# Run from the repo root. Pushes local apps-script/ to Google and
# updates the live web app deployment so the PWA hits the new code.
set -e
cd "$(dirname "$0")/apps-script"
echo "Pushing source to Google..."
clasp push
echo "Updating live deployment..."
clasp deploy
echo "Done. New code is live for the next +1 tap."
