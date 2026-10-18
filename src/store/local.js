// Local storage: data/protech.db (SQLite) with data/*.json kept as a readable copy.
// Used when no MySQL database is configured (e.g. when running on your own computer).
// Note: on Render's free plan the disk is wiped on every restart/deploy, so use MySQL there.

const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FALLBACKS = { users: [], carts: {}, orders: [], reviews: [] };

let database = null;

function db() {
  if (!database) {
    database = require("../database");
  }
  return database;
}

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

async function readJsonFile(name) {
  try {
    return JSON.parse(await fs.readFile(fileFor(name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function read(name) {
  const fromDb = await db().readDataset(name);
  if (fromDb !== null) {
    return fromDb;
  }

  const fromFile = await readJsonFile(name);
  const value = fromFile ?? structuredClone(FALLBACKS[name]);
  await db().writeDataset(name, value);
  return value;
}

async function write(name, value) {
  await db().writeDataset(name, value);

  // FIX: write to a temp file and rename, so a crash mid-write cannot leave a half-written file.
  await fs.mkdir(DATA_DIR, { recursive: true });
  const filePath = fileFor(name);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tempPath, filePath);
}

// Everything stored locally (used once to copy existing data into a new MySQL database).
async function readAllForMigration() {
  const result = {};
  for (const name of Object.keys(FALLBACKS)) {
    try {
      result[name] = await read(name);
    } catch (error) {
      // The SQLite package may be missing; fall back to the JSON copies.
      result[name] = (await readJsonFile(name).catch(() => null)) ?? structuredClone(FALLBACKS[name]);
    }
  }
  return result;
}

module.exports = {
  kind: "local",
  async init() {},
  readUsers: () => read("users"),
  writeUsers: (value) => write("users", value),
  readCarts: () => read("carts"),
  writeCarts: (value) => write("carts", value),
  readOrders: () => read("orders"),
  writeOrders: (value) => write("orders", value),
  readReviews: () => read("reviews"),
  writeReviews: (value) => write("reviews", value),
  async findUserById(id) {
    return (await read("users")).find((user) => user.id === id) || null;
  },
  async syncCatalog() {},
  async close() {},
  readAllForMigration
};
