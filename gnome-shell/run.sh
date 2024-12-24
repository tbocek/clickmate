#!/usr/bin/env bash

# Improved version based on https://betterdev.blog/minimal-safe-bash-script-template/
set -Eeuo pipefail
trap 'cleanup $?' SIGINT SIGTERM ERR EXIT

# Configuration
EXTENSION_UUID="clickmate@tbocek.github.com"
EXTENSION_DIR="$(pwd)/dist/"
LOCAL_EXTENSIONS_DIR="$HOME/.local/share/gnome-shell/extensions"

# Cleanup function
cleanup() {
  trap - SIGINT SIGTERM ERR EXIT
  echo "Cleaning up..."
  # Remove the symlink on exit
  if [ -L "$LOCAL_EXTENSIONS_DIR/$EXTENSION_UUID" ]; then
    rm "$LOCAL_EXTENSIONS_DIR/$EXTENSION_UUID"
  fi
}

setup_colors() {
  if [[ -t 2 ]] && [[ -z "${NO_COLOR-}" ]] && [[ "${TERM-}" != "dumb" ]]; then
    NOFORMAT='\033[0m' RED='\033[0;31m' GREEN='\033[0;32m'
  else
    NOFORMAT='' RED='' GREEN=''
  fi
}

msg() {
  echo >&2 -e "${1-}"
}

die() {
  msg "${RED}${1-}${NOFORMAT}"
  exit "${2-1}"
}

usage() {
  cat <<EOF
Usage: $(basename "${BASH_SOURCE[0]}") [-h] [-ss] [-sb] [-sd] [-rm]

Run dev environment for this gnome shell extension.

Available options:
-h, --help               Print this help and exit
EOF
  exit
}

parse_params() {
  while :; do
    case "${1-}" in
    -h | --help) usage ;;
    --no-color) NO_COLOR=1 ;;
    -?*) die "Unknown option: $1";;
    *) break ;;
    esac
    shift
  done

  #args=("$@")
  return 0
}

# Set up development environment
setup_dev_environment() {
  msg "Setting up development environment..."

  # Check if we're in the correct directory
  if [ ! -f "metadata.json" ]; then
    die "metadata.json not found. Are you in the extension directory?" 2
  fi

  # Remove existing symlink or directory if it exists
  if [ -e "$LOCAL_EXTENSIONS_DIR/$EXTENSION_UUID" ]; then
    msg "Removing existing extension link/directory..."
    rm -rf "$LOCAL_EXTENSIONS_DIR/$EXTENSION_UUID"
  fi

  # Create extensions directory if it doesn't exist
  mkdir -p "$LOCAL_EXTENSIONS_DIR"

  msg "Creating symlink to development directory..."
  ln -s "$EXTENSION_DIR" "$LOCAL_EXTENSIONS_DIR/$EXTENSION_UUID"

  gsettings set org.gnome.shell disable-user-extensions false

  # Enable debug output for GJS
  export GJS_DEBUG_OUTPUT=stderr
  export GJS_DEBUG_TOPICS="JS ERROR;JS LOG"

  # Point GNOME Shell to our development directory
  export GNOME_SHELL_EXTENSIONSDIR="$EXTENSION_DIR"
  export XDG_CURRENT_DESKTOP=dummy
  export XDG_DESKTOP_PORTAL_DIR=/dev/nullj

  rm -rf ~/.cache/gnome-shell/*
}

# Function to run nested GNOME Shell
run_nested_shell() {
  msg "Starting nested GNOME Shell..."

  dbus-run-session -- bash -c "
    # Set environment
    export GNOME_SHELL_EXTENSIONSDIR=\"$EXTENSION_DIR\"

    # Disable all extensions first
    gsettings set org.gnome.shell enabled-extensions \"[]\"
    gsettings set org.gnome.shell disabled-search-providers [\'org.gnome.Epiphany.desktop\']

    # Start shell
    gnome-shell --nested --wayland &
    SHELL_PID=\$!
    sleep 2

    # Enable only our extension
    gsettings set org.gnome.shell enabled-extensions \"['$EXTENSION_UUID']\"
    gnome-extensions enable $EXTENSION_UUID

    journalctl _PID=\$SHELL_PID -f -o cat &

    wait \$SHELL_PID
  " || die "Failed to run nested shell session" 3
}

setup_colors
parse_params "$@"
# Main execution
msg "${GREEN}Setting up development environment...${NOFORMAT}"
setup_dev_environment
run_nested_shell
