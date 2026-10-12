const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${__VERSION__}\n`);
} else {
  process.stdout.write('easyscp — friendly file transfers over SSH\n');
}
