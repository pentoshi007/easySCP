import { main } from './app/main.js';

const [major = 0] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`easyscp needs Node.js 22 or newer (you have ${process.version}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 500).unref();
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
