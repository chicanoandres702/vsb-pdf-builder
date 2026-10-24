#!/bin/bash
# Start Node.js PDF builder server and ensure nginx is running
cd /root/vsb

# Kill any existing node server on port 3000
fuser -k 3000/tcp 2>/dev/null
sleep 1

# Start Node server in background
nohup node server.js > /tmp/node_server.log 2>&1 &

# Ensure nginx is running
nginx -s reload 2>/dev/null || nginx

echo "Services started"
echo "  Node server: http://localhost:3000"
echo "  Web UI: http://64.177.42.6/"