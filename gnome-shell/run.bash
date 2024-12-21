#!/bin/bash

# Configuration
EXTENSION_UUID="clickmate.tbocek.github.com"
EXTENSION_DIR="$(pwd)"

# Set up development environment
setup_dev_environment() {
    # Enable GNOME Shell development mode
    gsettings set org.gnome.shell disable-user-extensions false

    # Enable debug output for GJS
    export GJS_DEBUG_OUTPUT=stderr
    export GJS_DEBUG_TOPICS="JS ERROR;JS LOG"

    # Point GNOME Shell to our development directory
    export GNOME_SHELL_EXTENSIONSDIR="$EXTENSION_DIR"
}

# Function to run nested GNOME Shell
run_nested_shell() {
    echo "Starting nested GNOME Shell..."
    echo "Extension directory: $EXTENSION_DIR"

    # Run nested shell with our extension directory
    GNOME_SHELL_EXTENSIONSDIR="$EXTENSION_DIR" \
    dbus-run-session -- gnome-shell --nested --wayland
}

# Main execution
echo "Setting up development environment..."
setup_dev_environment

run_nested_shell