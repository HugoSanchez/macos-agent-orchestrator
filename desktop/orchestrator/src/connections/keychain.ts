import { execFile } from 'node:child_process';

const SERVICE = 'com.verso.custom-connectors';

export type KeychainExec = (
  file: string,
  args: string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export class CustomConnectorKeychain {
  private readonly exec: KeychainExec;

  constructor(exec: KeychainExec = execFile) {
    this.exec = exec;
  }

  async setSecret(account: string, value: string): Promise<void> {
    await this.run([
      'add-generic-password',
      '-U',
      '-s',
      SERVICE,
      '-a',
      account,
      '-w',
      value,
    ]);
  }

  async getSecret(account: string): Promise<string | null> {
    const result = await this.run([
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      account,
      '-w',
    ], { allowFailure: true });
    if (result.failed) return null;
    return result.stdout.replace(/\r?\n$/, '');
  }

  async deleteSecret(account: string): Promise<void> {
    await this.run([
      'delete-generic-password',
      '-s',
      SERVICE,
      '-a',
      account,
    ], { allowFailure: true });
  }

  private run(args: string[], opts: { allowFailure?: boolean } = {}): Promise<{ stdout: string; failed: boolean }> {
    return new Promise((resolve, reject) => {
      this.exec('/usr/bin/security', args, (error, stdout, _stderr) => {
        if (error) {
          if (opts.allowFailure) {
            resolve({ stdout: '', failed: true });
            return;
          }
          reject(new Error('Keychain operation failed'));
          return;
        }
        resolve({ stdout, failed: false });
      });
    });
  }
}
