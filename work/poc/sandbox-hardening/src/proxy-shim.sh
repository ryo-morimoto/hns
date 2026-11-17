#!/run/current-system/sw/bin/sh
# A ProxyCommand adapter for tools that speak only an HTTP proxy URL.
#
# The sandbox has no route out, only a Unix socket. This wrapper is handed to a
# tool as its proxy *command* (git's http.proxy, ssh's ProxyCommand); git and ssh
# substitute %h/%p, npm substitutes nothing, so the caller passes the socket in
# HNS_PROXY_SOCKET and, for npm, the host and port as arguments.
#
# Usage: HNS_PROXY_SOCKET=<path> sh proxy-shim.sh <host> <port>
exec ${HNS_NODE:-node} "$(dirname "$0")/client.mjs" tcp-pipe "${HNS_PROXY_SOCKET:?}" "$1" "$2"
