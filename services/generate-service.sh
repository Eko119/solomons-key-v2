#!/usr/bin/env bash
# Solomon's Key — emit a systemd unit from a per-agent template.
# Useful if you later want to split an agent into its own long-running worker
# (e.g. a dedicated research poller). The main .service already runs the
# full orchestrator; these per-agent units are optional.

set -euo pipefail

AGENT="${1:-}"
PROJECT_ROOT="${PROJECT_ROOT:-/home/solomon/solomons-key}"
USER_NAME="${USER_NAME:-solomon}"

if [[ -z "$AGENT" ]]; then
  echo "usage: $0 <agent-id>"
  echo "  agent-id one of: main | comms | content | ops | research"
  exit 1
fi

case "$AGENT" in
  main|comms|content|ops|research) ;;
  *) echo "unknown agent: $AGENT"; exit 1 ;;
esac

OUTPUT="$PROJECT_ROOT/services/solomons-key-${AGENT}.service"

cat > "$OUTPUT" <<EOF
[Unit]
Description=Solomon's Key — ${AGENT} worker
After=network-online.target solomons-key-main.service
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${PROJECT_ROOT}
EnvironmentFile=${PROJECT_ROOT}/.env
Environment=SOLOMONS_KEY_AGENT=${AGENT}
ExecStart=/usr/bin/node ${PROJECT_ROOT}/dist/index.js --agent=${AGENT}
Restart=on-failure
RestartSec=5
StandardOutput=append:${PROJECT_ROOT}/logs/${AGENT}.log
StandardError=append:${PROJECT_ROOT}/logs/${AGENT}.err

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "✓ wrote $OUTPUT"
echo "  install: sudo cp $OUTPUT /etc/systemd/system/ && sudo systemctl daemon-reload"
