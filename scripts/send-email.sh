#!/bin/bash
# Deterministic email sender for scheduled tasks.
# Usage: send-email.sh --to <address> --subject <subject> --body-file <path>
#        send-email.sh --to <address> --subject <subject> --body <text>
#
# Loads SMTP config from /home/julian/temp/justclaw/.env automatically.
# Uses the sendEmail function from dist/email.js.

set -euo pipefail
cd /home/julian/temp/justclaw

TO=""
SUBJECT=""
BODY=""
BODY_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --to) TO="$2"; shift 2 ;;
    --subject) SUBJECT="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$TO" || -z "$SUBJECT" ]]; then
  echo "Usage: send-email.sh --to <address> --subject <subject> --body-file <path>"
  exit 1
fi

# Load .env — export each KEY=VALUE line, skip comments and empty lines
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  export "$key=$value"
done < .env

node -e "
const { sendEmail } = require('./dist/email.js');
const fs = require('fs');

const to = process.argv[1];
const subject = process.argv[2];
const bodyFile = process.argv[3];
const bodyInline = process.argv[4];

const text = bodyFile ? fs.readFileSync(bodyFile, 'utf-8') : bodyInline;

if (!text) {
  console.error('No body content provided');
  process.exit(1);
}

sendEmail({ to, subject, text }).then(ok => {
  if (ok) {
    console.log('Email sent successfully to ' + to);
  } else {
    console.error('Email send failed');
    process.exit(1);
  }
}).catch(err => {
  console.error('Email error:', err.message);
  process.exit(1);
});
" "$TO" "$SUBJECT" "$BODY_FILE" "$BODY"
