'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'the-weekly-'));
process.env.DB_FILE = path.join(temporaryDirectory, 'test.sqlite');
const db = require('../db');
const { createSessionStore } = require('../session-store');

test.after(() => {
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('creates all tables without third-party SQLite drivers', () => {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name);

  for (const table of [
    'users', 'articles', 'campaigns', 'deliveries',
    'sessions', 'webhook_events', 'scheduled_runs'
  ]) {
    assert.ok(tables.includes(table), `Missing table: ${table}`);
  }
});

test('inserts and reads article content using prepared statements', () => {
  const insert = db.prepare(`
    INSERT INTO articles (slug, title, category, excerpt, body)
    VALUES (?, ?, ?, ?, ?)
  `);

  insert.run('test-article', 'Test article', 'Markets', 'A preview', 'Private content');
  const article = db.prepare('SELECT * FROM articles WHERE slug = ?').get('test-article');
  assert.equal(article.title, 'Test article');
  assert.equal(article.body, 'Private content');
  assert.equal(article.status, 'draft');
});

test('creates, reads, updates, expires, and deletes sessions', async () => {
  class FakeStore {}
  const store = createSessionStore({ Store: FakeStore }, db);
  const run = (operation, ...args) => new Promise((resolve, reject) => {
    store[operation](...args, (error, value) => error ? reject(error) : resolve(value));
  });

  await run('set', 'session-1', {
    userId: 123,
    cookie: { expires: new Date(Date.now() + 60000) }
  });

  assert.equal((await run('get', 'session-1')).userId, 123);
  await run('touch', 'session-1', { cookie: { expires: new Date(Date.now() + 90000) } });
  await run('destroy', 'session-1');
  assert.equal(await run('get', 'session-1'), null);

  await run('set', 'session-expired', { cookie: { expires: new Date(Date.now() - 1000) } });
  assert.equal(await run('get', 'session-expired'), null);
  store.purgeExpired();
});

test('retains foreign-key constraints for campaign delivery records', () => {
  assert.throws(() => {
    db.prepare(`
      INSERT INTO deliveries (campaign_id, user_id, status)
      VALUES (99999, 99999, 'sent')
    `).run();
  }, /constraint|foreign key/i);
});
