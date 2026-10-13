import { readFile } from 'node:fs/promises';

const [version, sumsFile, base] = process.argv.slice(2);
if (!version || !sumsFile) {
  throw new Error('Usage: node scripts/formula.mjs <version> <SHA256SUMS> [download base URL]');
}
const downloads = base ?? `https://github.com/pentoshi007/easySCP/releases/download/v${version}`;

const sums = new Map();
for (const line of (await readFile(sumsFile, 'utf8')).split(/\r?\n/)) {
  const [hash, name] = line.trim().split(/\s+\*?/);
  if (hash && name) sums.set(name, hash);
}

const binary = (target) => {
  const name = `easyscp-${target}.gz`;
  const hash = sums.get(name);
  if (!hash) throw new Error(`${sumsFile} has no checksum for ${name}`);
  return [`      url "${downloads}/${name}"`, `      sha256 "${hash}"`].join('\n');
};

process.stdout.write(`class Easyscp < Formula
  desc "Send, receive and copy files over SSH by picking them, not typing paths"
  homepage "https://github.com/pentoshi007/easySCP"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${binary('darwin-arm64')}
    end
    on_intel do
${binary('darwin-x64')}
    end
  end

  on_linux do
    on_arm do
${binary('linux-arm64')}
    end
    on_intel do
${binary('linux-x64')}
    end
  end

  def install
    executable = Dir["easyscp-*"].first
    chmod 0755, executable
    bin.install executable => "easyscp"
    bin.install_symlink "easyscp" => "escp"
    generate_completions_from_executable(bin/"easyscp", "completion")
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/easyscp --version").strip
    assert_match "compdef", shell_output("#{bin}/escp completion zsh")
  end
end
`);
