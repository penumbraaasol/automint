import { createInterface } from 'node:readline';

/**
 * Hidden password prompt.
 *
 * Uses raw mode rather than readline: readline with terminal:true redraws the
 * line when question() is called, which wipes the prompt we just wrote and
 * leaves the user staring at a blank screen with no sign input is wanted.
 */
export async function promptPassword(label = 'Keystore password: ') {
  if (process.env.MINT_KEYSTORE_PASSWORD) return process.env.MINT_KEYSTORE_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new Error('No TTY and MINT_KEYSTORE_PASSWORD is unset -- cannot unlock keystore');
  }

  const EOT = '';        // ctrl-d
  const ETX = '';        // ctrl-c
  const DEL = '';        // backspace

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  process.stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let pw = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === EOT) {
          cleanup();
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (ch === ETX) {
          cleanup();
          process.stdout.write('\n');
          return reject(new Error('cancelled'));
        }
        if (ch === DEL || ch === '\b') {
          if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch >= ' ') { pw += ch; process.stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`${question} `, r));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}
