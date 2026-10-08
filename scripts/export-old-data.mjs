// One-time: turn the old laptop database (data/tracker.db) into a backup file you can
// restore in the app (Goals → Backup → Restore from backup).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(root, 'data', 'tracker.db');
if (!fs.existsSync(dbFile)) {
  console.log('No old data found (data/tracker.db) — nothing to export.');
  process.exit(0);
}
const db = new DatabaseSync(dbFile, { readOnly: true });
const rows = (sql) => db.prepare(sql).all();
const photos = {};
const entries = rows('SELECT * FROM entries').map((e) => {
  const file = e.photo_id && path.join(root, 'data', 'photos', e.photo_id);
  if (file && fs.existsSync(file)) photos[e.photo_id] = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
  const { id, nutrients, created_at, ...rest } = e;
  return { ...rest, nutrients: JSON.parse(nutrients), created_at: new Date(`${created_at}Z`).toISOString() };
});
const profileRow = rows("SELECT value FROM settings WHERE key = 'profile'")[0];
const backup = {
  app: 'jhu-fuel',
  version: 1,
  exportedAt: new Date().toISOString(),
  profile: profileRow ? JSON.parse(profileRow.value) : null,
  entries,
  weights: rows('SELECT date, weight_lb FROM weights'),
  foods: rows('SELECT * FROM foods').map(({ id, nutrients, barcode, ...f }) => ({ ...f, nutrients: JSON.parse(nutrients), ...(barcode ? { barcode } : {}) })),
  photos,
};
const out = path.join(root, 'jhu-fuel-backup.json');
fs.writeFileSync(out, JSON.stringify(backup));
console.log(`Saved ${entries.length} entries, ${backup.weights.length} weigh-ins and ${backup.foods.length} saved foods to ${out}`);
