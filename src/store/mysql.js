// MySQL storage. Every record is a normal row (users, orders, order_items, carts, cart_items,
// reviews, products, coupons), so you can browse and back up the data with phpMyAdmin,
// MySQL Workbench, DBeaver or your host's console.
//
// Connection settings (environment variables), either:
//   MYSQL_URL = mysql://USER:PASSWORD@HOST:PORT/DATABASE     (the "Service URI" Aiven shows)
// or separately: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
//
// SSL (cloud databases require it):
//   MYSQL_SSL_CA       the CA certificate text (-----BEGIN CERTIFICATE----- ...), or
//   MYSQL_SSL_CA_FILE  path to it, e.g. /etc/secrets/ca.pem (a Render "Secret File")
//   MYSQL_SSL=false    only for a database on your own computer without SSL
//
// Tables are created automatically on first start. If the database is empty, the existing
// local data (data/protech.db or data/*.json) is copied in once.

const fs = require("fs");

let pool = null;
const cache = { users: new Map(), carts: new Map(), orders: new Map(), reviews: new Map() };

// ---------- Connection ----------

function sslOptions() {
  const mode = String(process.env.MYSQL_SSL || "").trim().toLowerCase();
  if (mode === "false" || mode === "off" || mode === "disabled") {
    return undefined;
  }

  let ca = String(process.env.MYSQL_SSL_CA || "").trim();
  const caFile = String(process.env.MYSQL_SSL_CA_FILE || "").trim();

  if (!ca && caFile) {
    ca = fs.readFileSync(caFile, "utf8");
  }
  // Some dashboards turn line breaks into "\n" when you paste the certificate.
  ca = ca.replace(/\\n/g, "\n");

  if (ca) {
    return { ca, rejectUnauthorized: true, minVersion: "TLSv1.2" };
  }
  if (mode === "insecure") {
    // Encrypted, but the server certificate is not checked. Prefer MYSQL_SSL_CA.
    return { rejectUnauthorized: false, minVersion: "TLSv1.2" };
  }
  return { rejectUnauthorized: true, minVersion: "TLSv1.2" };
}

function connectionSettings() {
  const url = String(process.env.MYSQL_URL || "").trim();

  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "defaultdb"
    };
  }

  return {
    host: String(process.env.MYSQL_HOST || "").trim(),
    port: Number(process.env.MYSQL_PORT || 3306),
    user: String(process.env.MYSQL_USER || "").trim(),
    password: String(process.env.MYSQL_PASSWORD || ""),
    database: String(process.env.MYSQL_DATABASE || "").trim() || "defaultdb"
  };
}

function isConfigured() {
  return Boolean(String(process.env.MYSQL_URL || "").trim() || String(process.env.MYSQL_HOST || "").trim());
}

function explain(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error);

  if (code === "ER_ACCESS_DENIED_ERROR") {
    return `MySQL refused the username/password. Check MYSQL_URL (or MYSQL_USER / MYSQL_PASSWORD). (${message})`;
  }
  if (code === "ER_BAD_DB_ERROR") {
    return `The database name in MYSQL_URL doesn't exist. Aiven's default is "defaultdb". (${message})`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `MySQL host not found. Check the host in MYSQL_URL. (${message})`;
  }
  if (/certificate|self[- ]signed|SSL|TLS/i.test(message) || /CERT|SSL/.test(code)) {
    return `SSL problem talking to MySQL. Set MYSQL_SSL_CA to your database's CA certificate (Aiven: "CA certificate" on the service page). (${message})`;
  }
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED") {
    return `Could not reach MySQL. Check the host/port and that the database is running (free Aiven databases can be powered off; turn it on in the Aiven console). (${message})`;
  }
  return message;
}

// ---------- Helpers ----------

function toDbDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function fromDbDate(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text)) {
    const date = new Date(`${text.replace(" ", "T")}${/Z|[+-]\d{2}:?\d{2}$/.test(text) ? "" : "Z"}`);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return text;
}

function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function omit(object, keys) {
  const rest = {};
  Object.keys(object || {}).forEach((key) => {
    if (!keys.includes(key) && object[key] !== undefined) {
      rest[key] = object[key];
    }
  });
  return Object.keys(rest).length ? rest : null;
}

function setIf(target, key, value) {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

function chunks(list, size = 200) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function upsertSql(table, columns) {
  const updates = columns
    .slice(1)
    .map((column) => `${column} = VALUES(${column})`)
    .join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`;
}

// ---------- Schema ----------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS protech_meta (
    name VARCHAR(64) NOT NULL PRIMARY KEY,
    value TEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(191) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'customer',
    permissions_json TEXT NULL,
    auth_provider VARCHAR(64) NULL,
    created_at DATETIME(3) NULL,
    reset_token_hash VARCHAR(128) NULL,
    reset_expires_at DATETIME(3) NULL,
    access_updated_at DATETIME(3) NULL,
    access_updated_by VARCHAR(255) NULL,
    extra_json TEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(255) NOT NULL,
    category VARCHAR(64) NOT NULL,
    price DECIMAL(12,2) NOT NULL,
    sale_price DECIMAL(12,2) NULL,
    description TEXT NULL,
    image VARCHAR(500) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS coupons (
    code VARCHAR(64) NOT NULL PRIMARY KEY,
    type VARCHAR(32) NOT NULL,
    value DECIMAL(12,2) NOT NULL,
    min_subtotal DECIMAL(12,2) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    product_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    rating INT NOT NULL,
    comment TEXT NULL,
    created_at DATETIME(3) NULL,
    INDEX idx_reviews_product (product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    user_email VARCHAR(255) NULL,
    user_name VARCHAR(255) NULL,
    created_at DATETIME(3) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    subtotal DECIMAL(12,2) NULL,
    discount DECIMAL(12,2) NULL,
    total DECIMAL(12,2) NULL,
    coupon_json LONGTEXT NULL,
    delivery_json LONGTEXT NULL,
    payment_method VARCHAR(64) NULL,
    updated_at DATETIME(3) NULL,
    reordered_from VARCHAR(64) NULL,
    extra_json TEXT NULL,
    INDEX idx_orders_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    product_id VARCHAR(64) NULL,
    item_name VARCHAR(255) NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    quantity INT NOT NULL,
    INDEX idx_order_items_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS carts (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    UNIQUE KEY uq_carts_user_id (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cart_items (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cart_id INT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    product_id VARCHAR(64) NULL,
    item_name VARCHAR(255) NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    quantity INT NOT NULL,
    INDEX idx_cart_items_cart (cart_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// Columns added to tables that already existed (e.g. imported earlier from protech_phpmyadmin_import.sql).
const ADDED_COLUMNS = {
  users: {
    permissions_json: "TEXT NULL",
    reset_token_hash: "VARCHAR(128) NULL",
    reset_expires_at: "DATETIME(3) NULL",
    access_updated_at: "DATETIME(3) NULL",
    access_updated_by: "VARCHAR(255) NULL",
    extra_json: "TEXT NULL"
  },
  products: { sale_price: "DECIMAL(12,2) NULL", image: "VARCHAR(500) NULL" },
  orders: { reordered_from: "VARCHAR(64) NULL", extra_json: "TEXT NULL", updated_at: "DATETIME(3) NULL" },
  order_items: { sort_order: "INT NOT NULL DEFAULT 0", product_id: "VARCHAR(64) NULL" },
  cart_items: { sort_order: "INT NOT NULL DEFAULT 0", product_id: "VARCHAR(64) NULL" }
};

async function ensureColumns() {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set((await query(`SHOW COLUMNS FROM ${table}`)).map((row) => String(row.Field).toLowerCase()));
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) {
        await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`MySQL: added column ${table}.${column}`);
      }
    }
  }
}

// ---------- Users ----------

const USER_COLUMNS = [
  "id", "name", "email", "password_hash", "role", "permissions_json", "auth_provider", "created_at",
  "reset_token_hash", "reset_expires_at", "access_updated_at", "access_updated_by", "extra_json"
];
const USER_KEYS = [
  "id", "name", "email", "passwordHash", "role", "permissions", "authProvider", "createdAt",
  "resetPasswordTokenHash", "resetPasswordExpiresAt", "accessUpdatedAt", "accessUpdatedBy"
];

function userToRow(user) {
  return [
    String(user.id),
    String(user.name ?? ""),
    String(user.email ?? ""),
    user.passwordHash || null,
    user.role || "customer",
    Array.isArray(user.permissions) ? JSON.stringify(user.permissions) : null,
    user.authProvider || null,
    toDbDate(user.createdAt),
    user.resetPasswordTokenHash || null,
    toDbDate(user.resetPasswordExpiresAt),
    toDbDate(user.accessUpdatedAt),
    user.accessUpdatedBy || null,
    toJson(omit(user, USER_KEYS))
  ];
}

function rowToUser(row) {
  const user = { ...fromJson(row.extra_json, {}) };
  user.id = row.id;
  user.name = row.name;
  user.email = row.email;
  setIf(user, "passwordHash", row.password_hash);
  user.role = row.role || "customer";
  setIf(user, "permissions", fromJson(row.permissions_json, undefined));
  setIf(user, "authProvider", row.auth_provider);
  setIf(user, "createdAt", fromDbDate(row.created_at));
  setIf(user, "resetPasswordTokenHash", row.reset_token_hash);
  setIf(user, "resetPasswordExpiresAt", fromDbDate(row.reset_expires_at));
  setIf(user, "accessUpdatedAt", fromDbDate(row.access_updated_at));
  setIf(user, "accessUpdatedBy", row.access_updated_by);
  return user;
}

async function readUsers() {
  const rows = await query("SELECT * FROM users ORDER BY created_at, id");
  const users = rows.map(rowToUser);
  cache.users = new Map(users.map((user) => [user.id, JSON.stringify(userToRow(user))]));
  return users;
}

async function writeUsers(users) {
  const next = new Map();
  const rows = new Map();
  users.forEach((user) => {
    const row = userToRow(user);
    next.set(row[0], JSON.stringify(row));
    rows.set(row[0], row);
  });

  const changed = [...next.keys()].filter((id) => cache.users.get(id) !== next.get(id));
  const removed = [...cache.users.keys()].filter((id) => !next.has(id));

  if (changed.length || removed.length) {
    await transaction(async (connection) => {
      if (removed.length) {
        await connection.query("DELETE FROM users WHERE id IN (?)", [removed]);
      }
      for (const part of chunks(changed)) {
        await connection.query(upsertSql("users", USER_COLUMNS), [part.map((id) => rows.get(id))]);
      }
    });
  }
  cache.users = next;
}

async function findUserById(id) {
  const rows = await query("SELECT * FROM users WHERE id = ? LIMIT 1", [String(id || "")]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// ---------- Reviews ----------

const REVIEW_COLUMNS = ["id", "product_id", "user_id", "user_name", "rating", "comment", "created_at"];

function reviewToRow(review) {
  return [
    String(review.id),
    String(review.productId ?? ""),
    String(review.userId ?? ""),
    String(review.userName ?? ""),
    Math.floor(num(review.rating)),
    review.comment ?? null,
    toDbDate(review.createdAt)
  ];
}

function rowToReview(row) {
  return {
    id: row.id,
    productId: row.product_id,
    userId: row.user_id,
    userName: row.user_name,
    rating: num(row.rating),
    comment: row.comment ?? "",
    createdAt: fromDbDate(row.created_at) || ""
  };
}

async function readReviews() {
  const rows = await query("SELECT * FROM reviews ORDER BY created_at DESC, id");
  const reviews = rows.map(rowToReview);
  cache.reviews = new Map(reviews.map((review) => [review.id, JSON.stringify(reviewToRow(review))]));
  return reviews;
}

async function writeReviews(reviews) {
  const next = new Map();
  const rows = new Map();
  reviews.forEach((review) => {
    const row = reviewToRow(review);
    next.set(row[0], JSON.stringify(row));
    rows.set(row[0], row);
  });

  const changed = [...next.keys()].filter((id) => cache.reviews.get(id) !== next.get(id));
  const removed = [...cache.reviews.keys()].filter((id) => !next.has(id));

  if (changed.length || removed.length) {
    await transaction(async (connection) => {
      if (removed.length) {
        await connection.query("DELETE FROM reviews WHERE id IN (?)", [removed]);
      }
      for (const part of chunks(changed)) {
        await connection.query(upsertSql("reviews", REVIEW_COLUMNS), [part.map((id) => rows.get(id))]);
      }
    });
  }
  cache.reviews = next;
}

// ---------- Orders ----------

const ORDER_COLUMNS = [
  "id", "user_id", "user_email", "user_name", "created_at", "status", "subtotal", "discount", "total",
  "coupon_json", "delivery_json", "payment_method", "updated_at", "reordered_from", "extra_json"
];
const ORDER_KEYS = [
  "id", "userId", "userEmail", "userName", "createdAt", "status", "items", "subtotal", "discount", "total",
  "coupon", "delivery", "paymentMethod", "updatedAt", "reorderedFrom"
];
const ITEM_COLUMNS = ["sort_order", "product_id", "item_name", "unit_price", "quantity"];

function itemRows(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => [
    index,
    item?.productId || null,
    String(item?.name ?? ""),
    num(item?.price),
    Math.floor(num(item?.quantity))
  ]);
}

function rowToItem(row) {
  const item = {};
  setIf(item, "productId", row.product_id);
  item.name = row.item_name;
  item.price = num(row.unit_price);
  item.quantity = num(row.quantity);
  return item;
}

function orderToRow(order) {
  return [
    String(order.id),
    String(order.userId ?? ""),
    order.userEmail ?? null,
    order.userName ?? null,
    toDbDate(order.createdAt),
    String(order.status || "pending"),
    num(order.subtotal),
    num(order.discount),
    num(order.total),
    toJson(order.coupon ?? null),
    toJson(order.delivery ?? null),
    order.paymentMethod ?? null,
    toDbDate(order.updatedAt),
    order.reorderedFrom ?? null,
    toJson(omit(order, ORDER_KEYS))
  ];
}

function rowToOrder(row, items) {
  const order = { ...fromJson(row.extra_json, {}) };
  order.id = row.id;
  order.userId = row.user_id;
  order.userEmail = row.user_email;
  order.userName = row.user_name;
  order.createdAt = fromDbDate(row.created_at);
  order.status = row.status;
  order.items = items;
  order.subtotal = num(row.subtotal);
  order.discount = num(row.discount);
  order.total = num(row.total);
  order.coupon = fromJson(row.coupon_json, null);
  order.delivery = fromJson(row.delivery_json, null);
  order.paymentMethod = row.payment_method;
  setIf(order, "reorderedFrom", row.reordered_from);
  setIf(order, "updatedAt", fromDbDate(row.updated_at));
  return order;
}

function orderSignature(order) {
  return JSON.stringify([orderToRow(order), itemRows(order.items)]);
}

async function readOrders() {
  const [rows, items] = await Promise.all([
    query("SELECT * FROM orders ORDER BY created_at DESC, id DESC"),
    query("SELECT * FROM order_items ORDER BY order_id, sort_order, id")
  ]);
  const byOrder = new Map();
  items.forEach((item) => {
    if (!byOrder.has(item.order_id)) {
      byOrder.set(item.order_id, []);
    }
    byOrder.get(item.order_id).push(rowToItem(item));
  });
  const orders = rows.map((row) => rowToOrder(row, byOrder.get(row.id) || []));
  cache.orders = new Map(orders.map((order) => [order.id, orderSignature(order)]));
  return orders;
}

async function writeOrders(orders) {
  const next = new Map();
  const byId = new Map();
  orders.forEach((order) => {
    next.set(String(order.id), orderSignature(order));
    byId.set(String(order.id), order);
  });

  const changed = [...next.keys()].filter((id) => cache.orders.get(id) !== next.get(id));
  const removed = [...cache.orders.keys()].filter((id) => !next.has(id));
  const touched = [...changed, ...removed];

  if (touched.length) {
    await transaction(async (connection) => {
      for (const part of chunks(touched)) {
        await connection.query("DELETE FROM order_items WHERE order_id IN (?)", [part]);
      }
      if (removed.length) {
        await connection.query("DELETE FROM orders WHERE id IN (?)", [removed]);
      }
      for (const part of chunks(changed)) {
        await connection.query(upsertSql("orders", ORDER_COLUMNS), [part.map((id) => orderToRow(byId.get(id)))]);
        const itemValues = part.flatMap((id) => itemRows(byId.get(id).items).map((item) => [id, ...item]));
        if (itemValues.length) {
          await connection.query(`INSERT INTO order_items (order_id, ${ITEM_COLUMNS.join(", ")}) VALUES ?`, [itemValues]);
        }
      }
    });
  }
  cache.orders = next;
}

// ---------- Carts ----------

async function readCarts() {
  const rows = await query(
    `SELECT c.id AS cart_id, c.user_id AS user_id, i.id AS item_id, i.sort_order AS sort_order,
            i.product_id AS product_id, i.item_name AS item_name, i.unit_price AS unit_price, i.quantity AS quantity
     FROM carts c LEFT JOIN cart_items i ON i.cart_id = c.id
     ORDER BY c.id, i.sort_order, i.id`
  );
  const carts = {};
  rows.forEach((row) => {
    if (!carts[row.user_id]) {
      carts[row.user_id] = [];
    }
    if (row.item_id !== null && row.item_id !== undefined) {
      carts[row.user_id].push(rowToItem(row));
    }
  });
  cache.carts = new Map(Object.entries(carts).map(([userId, items]) => [userId, JSON.stringify(itemRows(items))]));
  return carts;
}

async function writeCarts(carts) {
  const next = new Map(
    Object.entries(carts || {}).map(([userId, items]) => [String(userId), JSON.stringify(itemRows(items))])
  );
  const changed = [...next.keys()].filter((id) => cache.carts.get(id) !== next.get(id));
  const removed = [...cache.carts.keys()].filter((id) => !next.has(id));

  if (changed.length || removed.length) {
    await transaction(async (connection) => {
      for (const userId of [...changed, ...removed]) {
        await connection.query(
          "DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = ?)",
          [userId]
        );
      }
      if (removed.length) {
        await connection.query("DELETE FROM carts WHERE user_id IN (?)", [removed]);
      }
      for (const userId of changed) {
        await connection.query("INSERT IGNORE INTO carts (user_id) VALUES (?)", [userId]);
        const [found] = await connection.query("SELECT id FROM carts WHERE user_id = ?", [userId]);
        const cartId = found[0].id;
        const items = itemRows(carts[userId]).map((item) => [cartId, ...item]);
        if (items.length) {
          await connection.query(`INSERT INTO cart_items (cart_id, ${ITEM_COLUMNS.join(", ")}) VALUES ?`, [items]);
        }
      }
    });
  }
  cache.carts = next;
}

// ---------- Catalog copy (products.json / coupons.json stay the source of truth) ----------

async function syncCatalog(products, coupons) {
  const productRows = (products || []).filter((p) => p.id).map((p) => [
    p.id, p.name || p.id, p.brand || "", p.category || "", num(p.price),
    Number.isFinite(Number(p.salePrice)) && p.salePrice !== null ? Number(p.salePrice) : null,
    p.description || null, p.image || null
  ]);
  const couponRows = (coupons || []).filter((c) => c.code).map((c) => [
    String(c.code).toUpperCase(), c.type || "fixed", num(c.value), num(c.minSubtotal), c.active ? 1 : 0
  ]);
  if (productRows.length) {
    await query(upsertSql("products", ["id", "name", "brand", "category", "price", "sale_price", "description", "image"]), [productRows]);
  }
  if (couponRows.length) {
    await query(upsertSql("coupons", ["code", "type", "value", "min_subtotal", "active"]), [couponRows]);
  }
}

// ---------- Start-up ----------

async function importLocalDataOnce() {
  const [marker] = await query("SELECT value FROM protech_meta WHERE name = 'local_import'");
  if (marker) {
    return;
  }

  const [{ n }] = await query("SELECT COUNT(*) AS n FROM users");
  if (Number(n) === 0) {
    let local = null;
    try {
      local = await require("./local").readAllForMigration();
    } catch (error) {
      console.warn("MySQL: could not read local data to copy:", error.message);
    }

    if (local) {
      const seen = new Set();
      const users = (local.users || []).filter((user) => {
        const email = String(user?.email || "").toLowerCase();
        if (!user?.id || !email || seen.has(email)) {
          return false;
        }
        seen.add(email);
        return true;
      });
      const orders = (local.orders || []).filter((order) => order?.id && order?.userId);
      const reviews = (local.reviews || []).filter((review) => review?.id);
      const carts = local.carts && typeof local.carts === "object" ? local.carts : {};

      cache.users = new Map();
      cache.orders = new Map();
      cache.reviews = new Map();
      cache.carts = new Map();
      await writeUsers(users);
      await writeOrders(orders);
      await writeReviews(reviews);
      await writeCarts(carts);
      console.log(
        `MySQL: copied local data: ${users.length} users, ${orders.length} orders, ${reviews.length} reviews, ${Object.keys(carts).length} carts.`
      );
    }
  }

  await query("INSERT IGNORE INTO protech_meta (name, value) VALUES ('local_import', ?)", [new Date().toISOString()]);
}

async function init() {
  const settings = connectionSettings();
  if (!settings.host || !settings.user) {
    throw new Error("MySQL settings are incomplete: set MYSQL_URL (or MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE).");
  }

  // Loaded here so the server still starts without the mysql2 package when MySQL isn't used.
  const mysql = require("mysql2/promise");
  pool = mysql.createPool({
    ...settings,
    ssl: sslOptions(),
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    decimalNumbers: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 5),
    waitForConnections: true,
    enableKeepAlive: true,
    connectTimeout: 20000
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await query("SELECT 1 AS ok");
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.warn(`MySQL: connection attempt ${attempt} failed: ${explain(error)}`);
      if (/ACCESS_DENIED|BAD_DB|ENOTFOUND/.test(String(error.code)) || /certificate|SSL|TLS/i.test(String(error.message))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  if (lastError) {
    const error = new Error(explain(lastError));
    error.cause = lastError;
    throw error;
  }

  for (const statement of SCHEMA) {
    await query(statement);
  }
  await ensureColumns();
  await importLocalDataOnce();
  console.log(`MySQL: connected to ${settings.host}:${settings.port}/${settings.database}.`);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  kind: "mysql",
  isConfigured,
  init,
  readUsers,
  writeUsers,
  findUserById,
  readCarts,
  writeCarts,
  readOrders,
  writeOrders,
  readReviews,
  writeReviews,
  syncCatalog,
  close
};
