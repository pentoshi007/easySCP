import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const SYSTEMS = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const KEYRING_TRIPLES = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-arm64': 'linux-arm64-gnu',
  'linux-x64': 'linux-x64-gnu',
  'win32-arm64': 'win32-arm64-msvc',
  'win32-x64': 'win32-x64-msvc',
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  throw new Error(
    `Building a standalone binary needs Node.js 25.5 or newer, not ${process.version}`,
  );
}

const platform = `${process.platform}-${process.arch}`;
const triple = KEYRING_TRIPLES[platform];
if (!triple) throw new Error(`No standalone build for ${platform}`);

const windows = process.platform === 'win32';
const name = `easyscp-${SYSTEMS[process.platform]}-${process.arch}${windows ? '.exe' : ''}`;
const work = path.join(root, 'build', 'sea');
const outDir = path.join(root, 'release');
const bundle = path.join(work, 'easyscp.mjs');
const binary = path.join(outDir, name);

const requireFrom = createRequire(
  path.join(root, 'node_modules', '@napi-rs', 'keyring', 'index.js'),
);
const keyringPackage = requireFrom.resolve(`@napi-rs/keyring-${triple}/package.json`);
const keyring = path.join(path.dirname(keyringPackage), `keyring.${triple}.node`);

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'cli.tsx')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${major}`,
  jsx: 'automatic',
  legalComments: 'none',
  external: ['@napi-rs/keyring', 'cpu-features', '*.node'],
  plugins: [
    {
      name: 'without-devtools',
      setup(builder) {
        builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'stub',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default {};',
        }));
      },
    },
  ],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { dirname as __dirnameOf } from 'node:path';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameOf(__filename);',
    ].join('\n'),
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'warning',
});

const config = path.join(work, 'sea-config.json');
await writeFile(
  config,
  JSON.stringify({
    main: bundle,
    mainFormat: 'module',
    output: binary,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    execArgvExtension: 'none',
    assets: { 'keyring.node': keyring },
  }),
);
await rm(binary, { force: true });
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', '--force', binary], { stdio: 'inherit' });
}

const reported = execFileSync(binary, ['--version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
if (reported !== pkg.version) {
  throw new Error(`${name} reported version "${reported}", expected ${pkg.version}`);
}

await pipeline(
  createReadStream(binary),
  createGzip({ level: 9 }),
  createWriteStream(`${binary}.gz`),
);
console.log(`Built release/${name} and release/${name}.gz`);
