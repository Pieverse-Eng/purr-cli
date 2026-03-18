#!/usr/bin/env bash
set -euo pipefail

# Purr CLI installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.sh | bash
# Pin a version: curl -fsSL ... | PURR_VERSION=v0.1.0 bash

REPO="Pieverse-Eng/purr-cli"
INSTALL_DIR="$HOME/.purrfectclaw/bin"
BINARY_NAME="purr"

# Detect OS
case "$(uname -s)" in
	Darwin) OS="darwin" ;;
	Linux) OS="linux" ;;
	*)
		echo "Error: unsupported OS $(uname -s)" >&2
		exit 1
		;;
esac

# Detect architecture
case "$(uname -m)" in
	x86_64) ARCH="x64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*)
		echo "Error: unsupported architecture $(uname -m)" >&2
		exit 1
		;;
esac

ASSET_NAME="purr-${OS}-${ARCH}"

# Resolve version
if [ -n "${PURR_VERSION:-}" ]; then
	TAG="$PURR_VERSION"
	# Ensure tag starts with v
	[[ "$TAG" == v* ]] || TAG="v$TAG"
	DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"
else
	DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
fi

echo "Installing purr CLI..."
echo "  OS:   ${OS}"
echo "  Arch: ${ARCH}"
echo "  From: ${DOWNLOAD_URL}"

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download binary
if command -v curl &>/dev/null; then
	curl -fsSL -o "${INSTALL_DIR}/${BINARY_NAME}" "$DOWNLOAD_URL"
elif command -v wget &>/dev/null; then
	wget -qO "${INSTALL_DIR}/${BINARY_NAME}" "$DOWNLOAD_URL"
else
	echo "Error: curl or wget required" >&2
	exit 1
fi

# Make executable
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

echo "Installed purr to ${INSTALL_DIR}/${BINARY_NAME}"

# Check PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
	echo ""
	echo "Add purr to your PATH by adding this to your shell profile:"
	echo ""
	echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
	echo ""
	echo "Then restart your shell or run: source ~/.bashrc (or ~/.zshrc)"
fi

# Verify installation
echo ""
if "${INSTALL_DIR}/${BINARY_NAME}" version 2>/dev/null; then
	echo "Installation complete!"
else
	echo "Warning: 'purr version' failed — the downloaded binary may not be compatible with your platform (${OS}/${ARCH})." >&2
	echo "Try downloading manually from: https://github.com/${REPO}/releases" >&2
	exit 1
fi
