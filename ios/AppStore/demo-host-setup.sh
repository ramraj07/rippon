#!/usr/bin/env bash
# Set up a throwaway Linux server for App Review to sign in to.
#
# Run as root on a fresh, small cloud VM (Ubuntu 22.04/24.04 or Debian 12) that has a public IP
# and port 22 open. It does not touch any other account. Re-running it is safe.
#
#   sudo REVIEW_PASSWORD='pick-a-long-random-one' bash demo-host-setup.sh
#
# What it does:
#   1. installs tmux and python3
#   2. creates the user `appreview` with that password, and allows password sign-in for that user
#      only (cloud images usually turn password sign-in off)
#   3. starts two tmux sessions with something to look at, plus a tiny web server on port 8000
#      that only listens on localhost, for trying port forwarding
#   4. adds a cron @reboot entry so the sessions come back if the VM restarts
#
# Delete the VM once the app is approved, and make a new one (with a new password) for the next
# review.
set -euo pipefail

USER_NAME=appreview
: "${REVIEW_PASSWORD:?set REVIEW_PASSWORD}"

if [ "$(id -u)" -ne 0 ]; then echo "run as root" >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux python3 >/dev/null

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$USER_NAME"
fi
echo "$USER_NAME:$REVIEW_PASSWORD" | chpasswd

# Password sign-in for this one user. A drop-in file wins over the defaults in sshd_config, and
# it is read first, so it has to be named early in the alphabet.
cat >/etc/ssh/sshd_config.d/00-appreview.conf <<EOF
Match User $USER_NAME
    PasswordAuthentication yes
    KbdInteractiveAuthentication yes
EOF
grep -q '^Include /etc/ssh/sshd_config.d/\*.conf' /etc/ssh/sshd_config \
  || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)

# Content for the sessions and the web server.
install -d -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/demo/site"
cat >"$HOME_DIR/demo/site/index.html" <<'EOF'
<!doctype html><meta name="viewport" content="width=device-width">
<title>Demo app</title>
<body style="font-family:-apple-system,sans-serif;padding:2em">
<h1>It works</h1>
<p>This page is served on the demo host at <code>localhost:8000</code> and reached through
Rippon's port forward.</p>
EOF

cat >"$HOME_DIR/demo/agent.sh" <<'EOF'
#!/usr/bin/env bash
# A stand-in for a coding agent: prints steady progress, with links to tap.
steps=("Reading the repository" "Planning the change" "Editing src/server.ts"
       "Running the tests: 42 passed" "Opening a pull request")
while true; do
  for s in "${steps[@]}"; do
    printf '\e[1;36m●\e[0m %s  \e[2m%s\e[0m\n' "$s" "$(date +%H:%M:%S)"
    sleep 4
  done
  echo "Pull request ready: https://github.com/ramraj07/rippon"
  echo "Docs: https://developer.apple.com/documentation/"
  echo
  sleep 6
done
EOF
chmod +x "$HOME_DIR/demo/agent.sh"

cat >"$HOME_DIR/demo/start.sh" <<'EOF'
#!/usr/bin/env bash
# Start the demo sessions and the web server if they aren't running.
cd "$HOME"
tmux has-session -t agent 2>/dev/null || tmux new-session -d -s agent "$HOME/demo/agent.sh"
tmux has-session -t shell 2>/dev/null || {
  tmux new-session -d -s shell
  tmux send-keys -t shell 'ls -la ~/demo && echo "Try typing here, or tap a link: https://www.apple.com"' Enter
}
if ! pgrep -u "$USER" -f 'http.server 8000' >/dev/null; then
  nohup python3 -m http.server 8000 --bind 127.0.0.1 --directory "$HOME/demo/site" </dev/null >/dev/null 2>&1 &
fi
EOF
chmod +x "$HOME_DIR/demo/start.sh"
chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/demo"

( crontab -u "$USER_NAME" -l 2>/dev/null | grep -v demo/start.sh || true; echo "@reboot $HOME_DIR/demo/start.sh" ) \
  | crontab -u "$USER_NAME" -
runuser -l "$USER_NAME" -c "$HOME_DIR/demo/start.sh"

IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "Ready. Put these in App Review Information → Notes:"
echo "  Host: $IP   Port: 22   User: $USER_NAME   Password: (the one you set)"
runuser -l "$USER_NAME" -c "tmux ls"
