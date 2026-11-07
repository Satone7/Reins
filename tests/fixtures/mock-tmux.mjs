import fs from 'node:fs';

const args = process.argv.slice(2);
const logPath = process.env.MOCK_TMUX_LOG;
const sessionPath = process.env.MOCK_TMUX_SESSION;
fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`, 'utf8');

if (args[0] === 'has-session') {
  process.exit(fs.existsSync(sessionPath) ? 0 : 1);
}
if (args[0] === 'new-session') {
  fs.writeFileSync(sessionPath, 'active', 'utf8');
  process.exit(0);
}
if (args[0] === 'send-keys') {
  process.exit(0);
}
process.stderr.write(`Unexpected tmux command: ${args.join(' ')}\n`);
process.exit(2);
