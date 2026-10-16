const cp = require('child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const code = `
const {app} = require('electron');
try { require('node:sqlite'); console.log('SQLITE OK'); }
catch (e) { console.log('SQLITE FAIL', e.message); }
app.quit();
`;
const r = cp.spawnSync('node_modules/electron/dist/electron.exe', ['-e', code], { env, timeout: 20000 });
console.log('stdout:', (r.stdout || '').toString());
console.log('stderr tail:', (r.stderr || '').toString().split('\n').slice(-5).join('\n'));
