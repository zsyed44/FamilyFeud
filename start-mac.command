#!/bin/bash
# Double-click to start Feud on macOS. Close this window to stop.
cd "$(dirname "$0")"
PORT=8080
if command -v python3 >/dev/null 2>&1; then
  (sleep 1; open "http://localhost:$PORT/") &
  echo "Feud is running at http://localhost:$PORT  (close this window to stop)"
  python3 -m http.server $PORT --bind 127.0.0.1
elif command -v node >/dev/null 2>&1; then
  (sleep 1; open "http://localhost:$PORT/") &
  node server.js
else
  echo "Python/Node not found - opening the game directly from disk."
  open index.html
fi
