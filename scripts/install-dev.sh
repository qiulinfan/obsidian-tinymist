#!/bin/sh
# Symlink this checkout into a vault's plugin directory for development.
set -eu
if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/vault" >&2
  exit 1
fi
vault=$1
repo=$(cd "$(dirname "$0")/.." && pwd)
plugdir="$vault/.obsidian/plugins"
mkdir -p "$plugdir"
plugin_id=$(node -e 'process.stdout.write(require(process.argv[1]).id)' "$repo/manifest.json")
target="$plugdir/$plugin_id"
if [ -e "$target" ] && [ ! -L "$target" ]; then
  echo "refusing to replace non-symlink $target" >&2
  exit 1
fi
ln -sfn "$repo" "$target"
echo "linked $target -> $repo"
echo "Enable 'Typst Live' in Obsidian community plugin settings, then restart Obsidian."
