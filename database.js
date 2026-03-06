const path = require("path");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATABASE_FILE = path.join(DATA_DIR, "protech.db");

let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: DATABASE_FILE,
      driver: sqlite3.Database
    }).then(async (db) => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS datasets (
          name TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);

      return db;
    });
  }

  return dbPromise;
}

async function readDataset(name) {
  const db = await getDb();
  const row = await db.get("SELECT payload FROM datasets WHERE name = ?", name);

  if (!row) {
    return null;
  }

  return JSON.parse(row.payload);
}

async function writeDataset(name, value) {
  const db = await getDb();
  const payload = JSON.stringify(value);
  const updatedAt = new Date().toISOString();

  await db.run(
    `
      INSERT INTO datasets(name, payload, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        payload = excluded.payload,
        updatedAt = excluded.updatedAt
    `,
    name,
    payload,
    updatedAt
  );
}

module.exports = {
  readDataset,
  writeDataset
};
