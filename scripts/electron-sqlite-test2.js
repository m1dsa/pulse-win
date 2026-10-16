// Run: electron scripts/electron-sqlite-test2.js — writes result to sqlite-test.out
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'sqlite-test.out');
try {
  const { app } = require('electron');
  app.whenReady().then(() => {
    let msg;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec('create table t(x)');
      msg = 'SQLITE OK ' + process.versions.node;
    } catch (e) {
      msg = 'SQLITE FAIL ' + process.versions.node + ' ' + e.message;
    }
    fs.writeFileSync(out, msg);
    app.exit(0);
  });
} catch (e) {
  fs.writeFileSync(out, 'NO APP ' + e.message);
  process.exit(0);
}
