#!/bin/sh
set -eu

say() { printf '%s\n' "$*"; }
fail() {
  printf 'easyscp: %s\n' "$*" >&2
  exit 1
}

profile_block() {
  [ -f "$1" ] && grep -q '# >>> easyscp path >>>' "$1" && return 0
  mkdir -p "$(dirname "$1")"
  printf '\n# >>> easyscp path >>>\n%s\n# <<< easyscp path <<<\n' "$2" >>"$1"
  say "Added $install_dir to PATH in $1"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --tries=3 --output-document="$2" "$1"
  else
    fail "curl or wget is needed to download easyscp"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

main() {
  repo="pentoshi007/easySCP"
  install_dir="${EASYSCP_INSTALL_DIR:-$HOME/.local/bin}"
  version="${EASYSCP_VERSION:-latest}"

  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "this installer supports macOS and Linux. On Windows run install.ps1 in PowerShell." ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "there is no standalone easyscp for $(uname -m). Install it with npm: npm install -g @pentoshi/easyscp" ;;
  esac

  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    arch=arm64
  fi

  if [ "$os" = linux ] && { ldd --version 2>&1 || true; } | grep -qi musl; then
    fail "the standalone easyscp needs glibc, which this system doesn't use. Install it with npm: npm install -g @pentoshi/easyscp"
  fi

  if [ -n "${EASYSCP_DOWNLOAD_BASE:-}" ]; then
    base="$EASYSCP_DOWNLOAD_BASE"
  elif [ "$version" = latest ]; then
    base="https://github.com/$repo/releases/latest/download"
  else
    base="https://github.com/$repo/releases/download/v${version#v}"
  fi

  asset="easyscp-$os-$arch.gz"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT INT TERM

  say "Downloading $asset"
  download "$base/$asset" "$work/$asset" || fail "couldn't download $base/$asset"
  download "$base/SHA256SUMS" "$work/SHA256SUMS" || fail "couldn't download the release checksums"

  expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || fail "the release checksums don't list $asset"
  [ "$(sha256 "$work/$asset")" = "$expected" ] || fail "the download doesn't match its published checksum"

  gunzip -c "$work/$asset" >"$work/easyscp"
  chmod 755 "$work/easyscp"
  installed="$(EASYSCP_NO_UPDATE_CHECK=1 "$work/easyscp" --version </dev/null)" || fail "the downloaded easyscp doesn't run on this computer"

  mkdir -p "$install_dir"
  mv -f "$work/easyscp" "$install_dir/easyscp"
  ln -sf easyscp "$install_dir/escp"
  say "Installed easyscp $installed to $install_dir"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      if [ -n "${EASYSCP_NO_MODIFY_PATH:-}" ]; then
        say "Add $install_dir to your PATH to run easyscp."
      else
        export_line="export PATH=\"$install_dir:\$PATH\""
        case "$(basename "${SHELL:-sh}")" in
          zsh) profile_block "${ZDOTDIR:-$HOME}/.zshrc" "$export_line" ;;
          bash)
            if [ "$os" = darwin ]; then
              profile_block "$HOME/.bash_profile" "$export_line"
            else
              profile_block "$HOME/.bashrc" "$export_line"
            fi
            ;;
          fish)
            profile_block "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/easyscp.fish" "fish_add_path -g \"$install_dir\""
            ;;
          *) profile_block "$HOME/.profile" "$export_line" ;;
        esac
      fi
      ;;
  esac

  if [ -z "${EASYSCP_NO_COMPLETION:-}" ]; then
    "$install_dir/easyscp" completion install </dev/null || true
  fi

  say "Open a new terminal and run: easyscp"
}

main "$@"
