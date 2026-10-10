#!/bin/sh
# Runs a command in a throwaway Node container, so nothing is installed on this computer:
#
#   tools/docker.sh npm ci
#   tools/docker.sh npm test
#   DOCKER_NETWORK=host tools/docker.sh npm run push -- <tv-ip> <pin>    (Linux: reach a TV by its address)
#
# NODE_IMAGE picks the image (default: node at the version in .nvmrc). Files are written as you, not root;
# the container has no extra privileges, and is removed when the command ends.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(tr -d ' \n' < "$root/.nvmrc" 2>/dev/null || true)
image=${NODE_IMAGE:-node:${version:-lts}}
tty=$([ -t 0 ] && [ -t 1 ] && echo "-t" || true)

exec docker run --rm -i $tty \
    --network "${DOCKER_NETWORK:-bridge}" \
    --user "$(id -u):$(id -g)" \
    --cap-drop ALL --security-opt no-new-privileges \
    -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
    -v "$root":/work -w /work \
    "$image" "$@"
