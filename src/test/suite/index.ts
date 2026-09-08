import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 30000,
    });

    const files = await glob('**/**.test.js', {
        cwd: path.resolve(__dirname, '.'),
    });

    for (const f of files) {
        mocha.addFile(path.resolve(__dirname, f));
    }

    await mocha.run();
}
