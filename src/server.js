const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { readDataset, writeDataset } = require("./database");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const IS_PRODUCTION =
  String(process.env.NODE_ENV || "").toLowerCase() === "production" || Boolean(process.env.RENDER);
const JWT_SECRET = resolveJwtSecret();
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const googleClient = new OAuth2Client();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 0);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();
const SMTP_SECURE = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || SMTP_PORT === 465;
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER || "").trim();

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CARTS_FILE = path.join(DATA_DIR, "carts.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const REVIEWS_FILE = path.join(DATA_DIR, "reviews.json");
const COUPONS_FILE = path.join(DATA_DIR, "coupons.json");
// FIX: no built-in admin email. Admins come only from ADMIN_EMAILS or role "admin" in the database.
// (Previously anyone could register "admin@protech.com" on a fresh database and become admin.)
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => normalizeEmail(email))
  .filter(Boolean);
// Super admins can do everything, including managing other admins. Set SUPER_ADMIN_EMAILS on the server
// (comma-separated) so at least one super admin always exists, even if the data is reset.
const SUPER_ADMIN_EMAILS = String(process.env.SUPER_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => normalizeEmail(email))
  .filter(Boolean);
// What an admin can be allowed to do. A "full" admin has all of these; a "limited" admin has some.
const ADMIN_PERMISSIONS = ["orders.view", "orders.update", "customers.view"];
// Only super admins can add, change or remove admins.
const TEAM_PERMISSION = "team.manage";
const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];
const MAX_QUANTITY_PER_ITEM = 99;
const PLACEHOLDER_IMAGE = "photos/placeholder.svg";
// FIX: password reset tokens are only returned in the API response when explicitly enabled for local testing.
const ALLOW_DEV_RESET_TOKEN =
  !IS_PRODUCTION && String(process.env.ALLOW_DEV_RESET_TOKEN || "").toLowerCase() === "true";
// Sale prices shown on discounts.html. The server is the source of truth for every price.
const SALE_PRICES = {
  "iphone-15": 799,
  "samsung-galaxy-s26-ultra": 999,
  "samsung-galaxy-s24": 739,
  "dell-xps-15": 1329,
  "asus-rog-zephyrus": 1614,
  "smart-watch-pro": 224,
  "mechanical-keyboard": 104
};
let mailTransporterPromise = null;

function resolveJwtSecret() {
  const configured = String(process.env.JWT_SECRET || "").trim();
  const isPlaceholder =
    configured === "change-this-to-a-long-random-string" || configured === "dev-insecure-secret-change-me";

  if (configured && configured.length >= 32 && !isPlaceholder) {
    return configured;
  }

  if (IS_PRODUCTION) {
    // FIX: never fall back to a publicly known secret in production.
    console.error(
      "FATAL: JWT_SECRET must be set to a random string of at least 32 characters. Refusing to start."
    );
    process.exit(1);
  }

  console.warn(
    "WARNING: JWT_SECRET is missing or too short. Using a random secret for this run only " +
      "(users will be signed out when the server restarts). Set JWT_SECRET to fix this."
  );
  return crypto.randomBytes(48).toString("hex");
}

// FIX: CORS can be limited to your frontend origin(s) with CORS_ORIGINS (comma-separated).
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

if (CORS_ORIGINS.length === 0) {
  console.warn("WARNING: CORS_ORIGINS is not set, so the API accepts requests from any website.");
}

app.set("trust proxy", 1);
app.use(
  cors({
    origin(origin, callback) {
      if (CORS_ORIGINS.length === 0 || !origin) {
        return callback(null, true);
      }

      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) || origin === "null";
      return callback(null, isLocal || CORS_ORIGINS.includes(origin));
    }
  })
);
app.use(express.json({ limit: "100kb" }));

// FIX: Express 4 does not catch errors thrown by async route handlers. An unhandled rejection
// crashes the whole Node process (e.g. changing the password of a Google-only account did this).
// Every route handler is now wrapped so errors go to the error middleware instead.
["get", "post", "put", "patch", "delete"].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    if (handlers.length === 0) {
      return original(routePath);
    }

    return original(
      routePath,
      ...handlers.map((handler) => (typeof handler === "function" ? asyncHandler(handler) : handler))
    );
  };
});

// FIX: all data is stored as whole datasets (read -> modify -> write). Two requests at the same time
// could overwrite each other's changes. Requests that change data now run one at a time.
let writeQueue = Promise.resolve();

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const run = writeQueue.then(
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 15000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        res.on("finish", done);
        res.on("close", done);
        next();
      })
  );
  writeQueue = run.catch(() => {});
});

// FIX: simple in-memory rate limiting for login, signup and password reset (no extra package needed).
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}|${req.baseUrl}${req.path}`;
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;

      if (entry.count > max) {
        res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
        return res.status(429).json({ message });
      }
    }

    if (hits.size > 10000) {
      for (const [entryKey, value] of hits) {
        if (value.resetAt <= now) {
          hits.delete(entryKey);
        }
      }
    }

    next();
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many sign-in attempts. Please wait a few minutes and try again."
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Too many accounts created from this network. Please try again later."
});
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many password reset requests. Please wait a few minutes and try again."
});
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "Too many reviews. Please try again later."
});

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function asyncHandler(handler) {
  if (handler.length === 4) {
    return handler;
  }

  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

// FIX: stronger password rule for new passwords (existing users can still sign in).
function passwordProblem(password) {
  const value = String(password || "");

  if (value.length < 8) {
    return "Password must be at least 8 characters.";
  }

  if (value.length > 128) {
    return "Password must be at most 128 characters.";
  }

  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return "Password must contain at least one letter and one number.";
  }

  return "";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

// Works out what a user may do. Server settings (SUPER_ADMIN_EMAILS / ADMIN_EMAILS) win over
// what is stored, and are "locked" so they can't be removed from the admin panel.
function accessFor(user) {
  if (!user) {
    return { role: "customer", permissions: [], locked: false };
  }

  const email = normalizeEmail(user.email);

  if (SUPER_ADMIN_EMAILS.includes(email)) {
    return { role: "superadmin", permissions: [...ADMIN_PERMISSIONS, TEAM_PERMISSION], locked: true };
  }

  if (user.role === "superadmin") {
    return { role: "superadmin", permissions: [...ADMIN_PERMISSIONS, TEAM_PERMISSION], locked: false };
  }

  if (ADMIN_EMAILS.includes(email)) {
    return { role: "admin", permissions: [...ADMIN_PERMISSIONS], locked: true };
  }

  if (user.role === "admin") {
    // Admins created before permissions existed keep full access.
    const permissions = Array.isArray(user.permissions)
      ? ADMIN_PERMISSIONS.filter((permission) => user.permissions.includes(permission))
      : [...ADMIN_PERMISSIONS];
    return { role: "admin", permissions, locked: false };
  }

  return { role: "customer", permissions: [], locked: false };
}

function accessLevel(access) {
  if (access.role === "superadmin") {
    return "super";
  }
  if (access.role === "admin") {
    return access.permissions.length === ADMIN_PERMISSIONS.length ? "full" : "limited";
  }
  return "none";
}

function sanitizeUser(user) {
  const access = accessFor(user);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    role: access.role,
    isAdmin: access.role !== "customer",
    isSuperAdmin: access.role === "superadmin",
    permissions: access.permissions,
    accessLevel: accessLevel(access)
  };
}

function orderId() {
  return `ORD-${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`;
}

function canSendWelcomeEmail() {
  return Boolean(SMTP_HOST && SMTP_PORT > 0 && SMTP_USER && SMTP_PASS && EMAIL_FROM);
}

async function getMailTransporter() {
  if (!canSendWelcomeEmail()) {
    return null;
  }

  if (!mailTransporterPromise) {
    mailTransporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS
        }
      })
    );
  }

  return mailTransporterPromise;
}

async function sendWelcomeEmail(user) {
  if (!canSendWelcomeEmail()) {
    return false;
  }

  try {
    const transporter = await getMailTransporter();

    if (!transporter) {
      return false;
    }

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: user.email,
      subject: "Welcome to ProTech",
      text: `Hi ${user.name},\n\nYour ProTech account was created successfully.\n\nEmail: ${user.email}\n\nThanks for joining ProTech.`
    });

    return true;
  } catch (error) {
    console.error("Welcome email failed:", error?.message || error);
    return false;
  }
}

function buildPasswordResetToken() {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  return {
    token,
    tokenHash,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };
}

async function sendPasswordResetEmail(user, resetToken) {
  if (!canSendWelcomeEmail()) {
    return false;
  }

  try {
    const transporter = await getMailTransporter();

    if (!transporter) {
      return false;
    }

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: user.email,
      subject: "ProTech password reset",
      text: `Hi ${user.name || "there"},\n\nUse this reset token to set a new password:\n${resetToken}\n\nThis token expires in 30 minutes.\n\nIf you did not request this, you can ignore this email.`
    });

    return true;
  } catch (error) {
    console.error("Password reset email failed:", error?.message || error);
    return false;
  }
}

function datasetKeyFromPath(filePath) {
  return path.basename(String(filePath || ""), ".json") || "dataset";
}

async function readJson(filePath, fallback) {
  const datasetKey = datasetKeyFromPath(filePath);

  const fromDb = await readDataset(datasetKey);

  if (fromDb !== null) {
    return fromDb;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    await writeDataset(datasetKey, parsed);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeDataset(datasetKey, fallback);
      return fallback;
    }
    throw error;
  }
}

// FIX: products.json and coupons.json are the source of truth for the catalog, so editing those files
// now takes effect. Before, the first copy saved in protech.db was used forever and file edits were ignored.
async function readCatalogFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  const datasetKey = datasetKeyFromPath(filePath);
  await writeDataset(datasetKey, value);

  // The JSON files stay as a mirror (used by scripts/generate-phpmyadmin-sql.js).
  // FIX: write to a temp file and rename, so a crash mid-write cannot leave a half-written file.
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tempPath, filePath);
}

async function readUsers() {
  return readJson(USERS_FILE, []);
}

async function writeUsers(users) {
  await writeJson(USERS_FILE, users);
}

async function readCarts() {
  return readJson(CARTS_FILE, {});
}

async function writeCarts(carts) {
  await writeJson(CARTS_FILE, carts);
}

async function readOrders() {
  return readJson(ORDERS_FILE, []);
}

async function writeOrders(orders) {
  await writeJson(ORDERS_FILE, orders);
}

const DEFAULT_PRODUCTS = [
  {
    id: "iphone-15",
    name: "iPhone 15",
    brand: "Apple",
    category: "phone",
    price: 999,
    description: "Latest Apple smartphone",
    image: "photos/iphone-15-black.jpg"
  },
  {
    id: "samsung-galaxy-s24",
    name: "Samsung Galaxy S24",
    brand: "Samsung",
    category: "phone",
    price: 899,
    description: "Premium Android phone",
    image: "photos/samsung-galaxy-s24-black.jpg"
  },
  {
    id: "google-pixel-10",
    name: "Google Pixel 10",
    brand: "Google",
    category: "phone",
    price: 799,
    description: "Clean Android experience",
    image: "photos/google-pixel-10-frost.jpg"
  },
  {
    id: "xiaomi-14",
    name: "Xiaomi 14",
    brand: "Xiaomi",
    category: "phone",
    price: 699,
    description: "Flagship features at great value",
    image: "photos/xiaomi-14-jade-green.jpg"
  },
  {
    id: "oneplus-11",
    name: "OnePlus 11",
    brand: "OnePlus",
    category: "phone",
    price: 749,
    description: "Fast and smooth performance",
    image: "photos/oneplus-11-titan-black.jpg"
  },
  {
    id: "samsung-galaxy-s26-ultra",
    name: "Samsung Galaxy S26 Ultra",
    brand: "Samsung",
    category: "phone",
    price: 1299,
    description: "Premium camera and performance",
    image: "photos/samsung-galaxy-s26-sky-blue.jpg"
  },
  {
    id: "macbook-pro-16",
    name: "MacBook Pro 16\"",
    brand: "Apple",
    category: "laptop",
    price: 2499,
    description: "Powerful performance laptop"
  },
  {
    id: "dell-xps-15",
    name: "Dell XPS 15",
    brand: "Dell",
    category: "laptop",
    price: 1699,
    description: "High-performance ultrabook"
  },
  {
    id: "lenovo-thinkpad-x1",
    name: "Lenovo ThinkPad X1",
    brand: "Lenovo",
    category: "laptop",
    price: 1499,
    description: "Business-class reliability"
  },
  {
    id: "asus-rog-zephyrus",
    name: "ASUS ROG Zephyrus",
    brand: "ASUS",
    category: "laptop",
    price: 1899,
    description: "Portable gaming powerhouse"
  },
  {
    id: "gaming-pc-rtx-4090",
    name: "Gaming PC RTX 4090",
    brand: "ProTech",
    category: "others",
    price: 3299,
    description: "Ultimate gaming machine"
  },
  {
    id: "smart-watch-pro",
    name: "Smart Watch Pro",
    brand: "ProTech",
    category: "others",
    price: 299,
    description: "Fitness and notifications on your wrist"
  },
  {
    id: "wireless-headphones",
    name: "Wireless Headphones",
    brand: "ProTech",
    category: "others",
    price: 249,
    description: "Noise cancellation and rich sound"
  },
  {
    id: "mechanical-keyboard",
    name: "Mechanical Keyboard",
    brand: "ProTech",
    category: "others",
    price: 149,
    description: "Fast response with tactile switches"
  }
];

const DEFAULT_COUPONS = [
  {
    code: "WELCOME10",
    type: "percent",
    value: 10,
    minSubtotal: 50,
    active: true
  },
  {
    code: "SAVE50",
    type: "fixed",
    value: 50,
    minSubtotal: 500,
    active: true
  }
];

async function readProducts() {
  return readCatalogFile(PRODUCTS_FILE, DEFAULT_PRODUCTS);
}

async function readCatalog() {
  const products = (await readProducts()).map(normalizeProduct);
  const byId = new Map(products.map((product) => [product.id, product]));
  const byName = new Map(products.map((product) => [productNameKey(product.name), product]));
  return { products, byId, byName };
}

function productNameKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// FIX (price tampering): the browser only says WHICH product and HOW MANY.
// The price always comes from the catalog. The only prices accepted are the normal
// price or the advertised sale price; anything else is replaced with the normal price.
function priceItemsFromCatalog(rawItems, catalog) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const merged = new Map();

  rawItems.forEach((item) => {
    const id = String(item?.productId || item?.id || "").trim();
    const product = (id && catalog.byId.get(id)) || catalog.byName.get(productNameKey(item?.name));

    if (!product) {
      throw httpError(400, `Unknown product: ${String(item?.name || id || "").slice(0, 80)}`);
    }

    const quantity = Math.floor(Number(item?.quantity || 0));

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return;
    }

    const requestedPrice = Number(item?.price);
    const allowedPrices = [product.price, product.salePrice].filter((price) => Number.isFinite(price));
    const unitPrice = allowedPrices.includes(requestedPrice) ? requestedPrice : product.price;
    const key = `${product.id}|${unitPrice}`;
    const existing = merged.get(key);

    if (existing) {
      existing.quantity = Math.min(MAX_QUANTITY_PER_ITEM, existing.quantity + quantity);
    } else {
      merged.set(key, {
        productId: product.id,
        name: product.name,
        price: unitPrice,
        quantity: Math.min(MAX_QUANTITY_PER_ITEM, quantity)
      });
    }
  });

  return Array.from(merged.values());
}

async function readReviews() {
  return readJson(REVIEWS_FILE, []);
}

async function writeReviews(reviews) {
  await writeJson(REVIEWS_FILE, reviews);
}

async function readCoupons() {
  return readCatalogFile(COUPONS_FILE, DEFAULT_COUPONS);
}

function normalizeProduct(product) {
  let image = String(product?.image || "").trim();
  const id = String(product?.id || "").trim();
  const salePrice = Number(product?.salePrice ?? SALE_PRICES[id]);

  // FIX: via.placeholder.com no longer works, so those images were broken.
  if (!image || /via\.placeholder\.com/i.test(image)) {
    image = productImageFallback(product);
  }

  return {
    id,
    name: String(product?.name || "").trim(),
    brand: String(product?.brand || "").trim(),
    category: String(product?.category || "").trim().toLowerCase(),
    price: Number(product?.price || 0),
    salePrice: Number.isFinite(salePrice) && salePrice > 0 ? salePrice : null,
    description: String(product?.description || "").trim(),
    image
  };
}

function normalizeReview(review) {
  return {
    id: String(review?.id || "").trim(),
    productId: String(review?.productId || "").trim(),
    userId: String(review?.userId || "").trim(),
    userName: String(review?.userName || "").trim(),
    rating: Math.max(1, Math.min(5, Math.floor(Number(review?.rating || 0)))),
    comment: String(review?.comment || "").trim(),
    createdAt: String(review?.createdAt || "").trim()
  };
}

function normalizeCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

function productImageFallback(_product) {
  return PLACEHOLDER_IMAGE;
}

function isAdminUser(user) {
  return accessFor(user).role !== "customer";
}

function calculateCouponDiscount(coupon, subtotal) {
  if (!coupon || !coupon.active) {
    return 0;
  }

  if (Number(coupon.minSubtotal || 0) > subtotal) {
    return 0;
  }

  if (coupon.type === "percent") {
    return Math.round((subtotal * Number(coupon.value || 0)) / 100);
  }

  if (coupon.type === "fixed") {
    return Math.min(subtotal, Number(coupon.value || 0));
  }

  return 0;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role || "customer", isAdmin: isAdminUser(user) },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Missing or invalid token." });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role || "customer",
      isAdmin: Boolean(payload.isAdmin || payload.role === "admin")
    };
    next();
  } catch (error) {
    return res.status(401).json({ message: "Token expired or invalid." });
  }
}

async function adminRequired(req, res, next) {
  const user = await getCurrentUserById(req.auth.userId);

  if (!isAdminUser(user)) {
    return res.status(403).json({ message: "Admin access required." });
  }

  req.admin = user;
  req.access = accessFor(user);
  next();
}

// Checked against the stored user on every request, so access changes apply immediately.
function requirePermission(...anyOf) {
  return async (req, res, next) => {
    const user = await getCurrentUserById(req.auth.userId);
    const access = accessFor(user);

    if (access.role === "customer") {
      return res.status(403).json({ message: "Admin access required." });
    }

    if (!anyOf.some((permission) => access.permissions.includes(permission))) {
      return res.status(403).json({ message: "Your admin account doesn't have permission to do this." });
    }

    req.admin = user;
    req.access = access;
    next();
  };
}

function normalizeCartItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      name: String(item?.name || "").trim(),
      price: Number(item?.price || 0),
      quantity: Number(item?.quantity || 0)
    }))
    .filter((item) => item.name && item.price >= 0 && item.quantity > 0)
    .map((item) => ({
      ...item,
      quantity: Math.floor(item.quantity)
    }));
}

function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

async function getCurrentUserById(userId) {
  const users = await readUsers();
  return users.find((user) => user.id === userId) || null;
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "protech-backend", date: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({
    message: "ProTech backend API is running.",
    health: "/api/health",
    auth: {
      register: "/api/auth/register",
      signup: "/api/auth/signup",
      login: "/api/auth/login",
      signin: "/api/auth/signin",
      google: "/api/auth/google"
    }
  });
});

app.get("/api/products", async (req, res) => {
  const products = (await readProducts()).map(normalizeProduct);
  const search = String(req.query.search || "").trim().toLowerCase();
  const category = String(req.query.category || "").trim().toLowerCase();
  const brand = String(req.query.brand || "").trim().toLowerCase();
  // FIX: an invalid number (e.g. maxPrice=abc) used to become NaN and hide every product.
  const parsedMin = Number.parseFloat(req.query.minPrice);
  const parsedMax = Number.parseFloat(req.query.maxPrice);
  const minPrice = Number.isFinite(parsedMin) ? parsedMin : 0;
  const maxPrice = Number.isFinite(parsedMax) ? parsedMax : Number.POSITIVE_INFINITY;
  const sort = String(req.query.sort || "").trim().toLowerCase();

  const filtered = products.filter((product) => {
    const passesSearch =
      !search ||
      product.name.toLowerCase().includes(search) ||
      product.description.toLowerCase().includes(search);
    const passesCategory = !category || product.category === category;
    const passesBrand = !brand || product.brand.toLowerCase() === brand;
    const passesPrice = product.price >= minPrice && product.price <= maxPrice;
    return passesSearch && passesCategory && passesBrand && passesPrice;
  });

  if (sort === "price-asc") {
    filtered.sort((a, b) => a.price - b.price);
  } else if (sort === "price-desc") {
    filtered.sort((a, b) => b.price - a.price);
  } else if (sort === "name-asc") {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "name-desc") {
    filtered.sort((a, b) => b.name.localeCompare(a.name));
  }

  res.json({ items: filtered, count: filtered.length });
});

app.get("/api/products/:productId", async (req, res) => {
  const productId = String(req.params.productId || "").trim();
  const products = (await readProducts()).map(normalizeProduct);
  const product = products.find((entry) => entry.id === productId);

  if (!product) {
    return res.status(404).json({ message: "Product not found." });
  }

  res.json({ product });
});

app.get("/api/products/:productId/reviews", async (req, res) => {
  const productId = String(req.params.productId || "").trim();
  const products = (await readProducts()).map(normalizeProduct);
  const productExists = products.some((entry) => entry.id === productId);

  if (!productExists) {
    return res.status(404).json({ message: "Product not found." });
  }

  const reviews = (await readReviews())
    .map(normalizeReview)
    .filter((review) => review.productId === productId);
  const averageRating =
    reviews.length === 0
      ? 0
      : Number((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length).toFixed(2));

  res.json({ reviews, averageRating, count: reviews.length });
});

app.post("/api/products/:productId/reviews", reviewLimiter, authRequired, async (req, res) => {
  const productId = String(req.params.productId || "").trim();
  const rating = Math.floor(Number(req.body?.rating || 0));
  const comment = String(req.body?.comment || "").trim();

  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }

  if (comment.length < 3) {
    return res.status(400).json({ message: "Comment must be at least 3 characters." });
  }

  if (comment.length > 1000) {
    return res.status(400).json({ message: "Comment must be at most 1000 characters." });
  }

  const user = await getCurrentUserById(req.auth.userId);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const products = (await readProducts()).map(normalizeProduct);
  const productExists = products.some((entry) => entry.id === productId);

  if (!productExists) {
    return res.status(404).json({ message: "Product not found." });
  }

  const reviews = (await readReviews()).map(normalizeReview);
  const existingIndex = reviews.findIndex(
    (review) => review.productId === productId && review.userId === req.auth.userId
  );

  const newReview = {
    id: existingIndex >= 0 ? reviews[existingIndex].id : uuidv4(),
    productId,
    userId: user.id,
    userName: user.name,
    rating,
    comment,
    createdAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    reviews[existingIndex] = newReview;
  } else {
    reviews.unshift(newReview);
  }

  await writeReviews(reviews);
  res.status(existingIndex >= 0 ? 200 : 201).json({ review: newReview });
});

app.post("/api/coupons/validate", (req, res) => {
  const code = normalizeCouponCode(req.body?.code);
  const subtotal = Number(req.body?.subtotal || 0);

  if (!code) {
    return res.status(400).json({ message: "Coupon code is required." });
  }

  if (subtotal < 0) {
    return res.status(400).json({ message: "Subtotal must be a positive number." });
  }

  readCoupons()
    .then((coupons) => {
      const coupon = coupons.find((entry) => normalizeCouponCode(entry.code) === code);

      if (!coupon || !coupon.active) {
        return res.status(404).json({ message: "Coupon not found or inactive." });
      }

      if (Number(coupon.minSubtotal || 0) > subtotal) {
        return res.status(400).json({
          message: `Coupon requires minimum subtotal of $${Number(coupon.minSubtotal || 0)}.`
        });
      }

      const discount = calculateCouponDiscount(coupon, subtotal);
      const total = Math.max(0, subtotal - discount);

      res.json({
        coupon: {
          code: normalizeCouponCode(coupon.code),
          type: coupon.type,
          value: Number(coupon.value || 0),
          minSubtotal: Number(coupon.minSubtotal || 0)
        },
        subtotal,
        discount,
        total
      });
    })
    .catch(() => {
      res.status(500).json({ message: "Could not validate coupon." });
    });
});

const registerHandler = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (name.length < 2) {
    return res.status(400).json({ message: "Name must be at least 2 characters." });
  }

  if (name.length > 80) {
    return res.status(400).json({ message: "Name must be at most 80 characters." });
  }

  if (!isValidEmail(email) || email.length > 254) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  const passwordError = passwordProblem(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  const users = await readUsers();
  const existing = users.find((user) => normalizeEmail(user.email) === email);

  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    name,
    email,
    passwordHash,
    role: "customer",
    createdAt: new Date().toISOString()
  };

  users.push(user);
  await writeUsers(users);

  const emailSent = await sendWelcomeEmail(user);

  const token = signToken(user);
  res.status(201).json({ user: sanitizeUser(user), token, emailSent });
});

app.post("/api/auth/register", registerLimiter, registerHandler);
app.post("/api/auth/signup", registerLimiter, registerHandler);

app.post("/api/auth/google", loginLimiter, asyncHandler(async (req, res) => {
  const credential = String(req.body?.credential || "").trim();

  if (!credential) {
    return res.status(400).json({ message: "Google credential is required." });
  }

  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes("YOUR_GOOGLE_CLIENT_ID")) {
    return res.status(500).json({
      message: "Google Sign-In is not configured on the server. Set GOOGLE_CLIENT_ID."
    });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload() || {};
    const email = normalizeEmail(payload.email);
    const name = String(payload.name || "Google User").trim();
    const emailVerified = Boolean(payload.email_verified);

    if (!emailVerified) {
      return res.status(400).json({ message: "Google account email is not verified." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Please provide a valid email." });
    }

    const users = await readUsers();
    const existingIndex = users.findIndex((user) => normalizeEmail(user.email) === email);
    if (existingIndex === -1) {
      const newUser = {
        id: uuidv4(),
        name: name.length >= 2 ? name : "Google User",
        email,
        authProvider: "google",
        role: "customer",
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      await writeUsers(users);

      const token = signToken(newUser);
      return res.status(201).json({ user: sanitizeUser(newUser), token });
    }

    const existingUser = users[existingIndex];
    users[existingIndex] = {
      ...existingUser,
      authProvider: existingUser.authProvider || "google",
      role: existingUser.role || "customer"
    };

    await writeUsers(users);

    const token = signToken(users[existingIndex]);
    return res.json({ user: sanitizeUser(users[existingIndex]), token });
  } catch (error) {
    return res.status(401).json({ message: "Google token is invalid or expired." });
  }
}));

const loginHandler = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  if (!password) {
    return res.status(400).json({ message: "Password is required." });
  }

  const users = await readUsers();
  const user = users.find((candidate) => normalizeEmail(candidate.email) === email);

  if (!user) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  if (!user.passwordHash) {
    return res.status(401).json({
      message: "This account uses Google Sign-In. Please continue with Google."
    });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  const token = signToken(user);
  res.json({ user: sanitizeUser(user), token });
});

app.post("/api/auth/login", loginLimiter, loginHandler);
app.post("/api/auth/signin", loginLimiter, loginHandler);

app.post("/api/auth/forgot-password", passwordResetLimiter, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  // FIX: same answer whether or not the account exists, so emails cannot be probed.
  const genericMessage =
    "If an account exists for this email, password reset instructions have been sent to it.";

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((entry) => normalizeEmail(entry.email) === email);

  if (userIndex === -1 || !users[userIndex].passwordHash) {
    return res.json({ message: genericMessage, expiresInMinutes: 30 });
  }

  const generated = buildPasswordResetToken();
  users[userIndex].resetPasswordTokenHash = generated.tokenHash;
  users[userIndex].resetPasswordExpiresAt = generated.expiresAt;
  await writeUsers(users);

  const emailSent = await sendPasswordResetEmail(users[userIndex], generated.token);

  if (!emailSent) {
    console.warn("Password reset requested but SMTP is not configured, so no email was sent.");
  }

  // FIX: the reset token is NEVER sent back in the response, because that let anyone who knew an
  // email address take over the account. Only for local testing, ALLOW_DEV_RESET_TOKEN=true
  // (ignored in production) brings the old behaviour back.
  res.json({
    message: genericMessage,
    resetToken: ALLOW_DEV_RESET_TOKEN && !emailSent ? generated.token : undefined,
    expiresInMinutes: 30
  });
}));

app.post("/api/auth/reset-password", passwordResetLimiter, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const resetToken = String(req.body?.resetToken || "").trim();
  const newPassword = String(req.body?.newPassword || "");

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  if (!resetToken) {
    return res.status(400).json({ message: "Reset token is required." });
  }

  const resetPasswordError = passwordProblem(newPassword);
  if (resetPasswordError) {
    return res.status(400).json({ message: resetPasswordError });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((entry) => normalizeEmail(entry.email) === email);

  if (userIndex === -1) {
    return res.status(400).json({ message: "Invalid email or reset token." });
  }

  const user = users[userIndex];
  const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const expiresAt = new Date(user.resetPasswordExpiresAt || 0).getTime();
  const isExpired = !expiresAt || expiresAt < Date.now();

  const storedHash = String(user.resetPasswordTokenHash || "");
  const tokenMatches =
    storedHash.length === tokenHash.length &&
    crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(tokenHash));

  if (!tokenMatches || isExpired) {
    return res.status(400).json({ message: "Reset token is invalid or expired." });
  }

  users[userIndex].passwordHash = await bcrypt.hash(newPassword, 10);
  delete users[userIndex].resetPasswordTokenHash;
  delete users[userIndex].resetPasswordExpiresAt;
  await writeUsers(users);

  res.json({ message: "Password reset successfully. You can sign in now." });
}));

app.post("/api/auth/logout", (_req, res) => {
  // JWT logout is handled client-side by discarding the token.
  res.json({ message: "Signed out successfully." });
});

app.get("/api/auth/me", authRequired, asyncHandler(async (req, res) => {
  const user = await getCurrentUserById(req.auth.userId);

  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  res.json({ user: sanitizeUser(user) });
}));

// FIX: this endpoint used to be public, so anyone on the internet could make any account an admin.
// Now only a super admin can use it (the admin panel's Team tab is the normal way to do this).
app.post("/api/dev/make-admin", authRequired, requirePermission(TEAM_PERMISSION), async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Valid email is required." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((user) => normalizeEmail(user.email) === email);

  if (userIndex === -1) {
    return res.status(404).json({ message: "User not found." });
  }

  if (users[userIndex].id === req.admin.id) {
    return res.status(400).json({ message: "You can't change your own access." });
  }

  users[userIndex].role = "admin";
  users[userIndex].permissions = [...ADMIN_PERMISSIONS];
  await writeUsers(users);

  res.json({
    message: `User ${email} is now admin.`,
    user: sanitizeUser(users[userIndex])
  });
});

app.put("/api/profile", authRequired, async (req, res) => {
  const nextName = String(req.body?.name || "").trim();

  if (nextName.length < 2) {
    return res.status(400).json({ message: "Name must be at least 2 characters." });
  }

  if (nextName.length > 80) {
    return res.status(400).json({ message: "Name must be at most 80 characters." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((user) => user.id === req.auth.userId);

  if (userIndex === -1) {
    return res.status(404).json({ message: "User not found." });
  }

  users[userIndex].name = nextName;
  await writeUsers(users);

  res.json({ user: sanitizeUser(users[userIndex]) });
});

app.put("/api/profile/password", authRequired, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");

  const newPasswordError = passwordProblem(newPassword);
  if (newPasswordError) {
    return res.status(400).json({ message: newPasswordError });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((user) => user.id === req.auth.userId);

  if (userIndex === -1) {
    return res.status(404).json({ message: "User not found." });
  }

  // FIX: Google-only accounts have no password; bcrypt threw here and crashed the server.
  if (!users[userIndex].passwordHash) {
    return res.status(400).json({
      message: "This account uses Google Sign-In and has no password to change."
    });
  }

  const passwordOk = await bcrypt.compare(currentPassword, users[userIndex].passwordHash);

  if (!passwordOk) {
    return res.status(400).json({ message: "Current password is incorrect." });
  }

  users[userIndex].passwordHash = await bcrypt.hash(newPassword, 10);
  await writeUsers(users);

  res.json({ message: "Password updated successfully." });
});

app.get("/api/cart", authRequired, async (req, res) => {
  const carts = await readCarts();
  const items = normalizeCartItems(carts[req.auth.userId] || []);
  res.json({ items, total: calculateTotal(items) });
});

app.put("/api/cart", authRequired, async (req, res) => {
  const catalog = await readCatalog();
  const items = priceItemsFromCatalog(req.body?.items || [], catalog);
  const carts = await readCarts();

  carts[req.auth.userId] = items;
  await writeCarts(carts);

  res.json({ items, total: calculateTotal(items) });
});

app.post("/api/cart/items", authRequired, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const quantity = Math.max(1, Math.floor(Number(req.body?.quantity || 1)));

  if (!name && !req.body?.productId) {
    return res.status(400).json({ message: "Item name is required." });
  }

  const catalog = await readCatalog();
  const carts = await readCarts();
  const currentItems = priceItemsFromCatalog(
    [
      ...normalizeCartItems(carts[req.auth.userId] || []),
      { productId: req.body?.productId, name, price: req.body?.price, quantity }
    ],
    catalog
  );

  carts[req.auth.userId] = currentItems;
  await writeCarts(carts);

  res.status(201).json({ items: currentItems, total: calculateTotal(currentItems) });
});

app.delete("/api/cart/items/:name", authRequired, async (req, res) => {
  const targetName = String(req.params.name || "").trim();
  const carts = await readCarts();
  const currentItems = normalizeCartItems(carts[req.auth.userId] || []);
  const filteredItems = currentItems.filter((item) => item.name !== targetName);

  carts[req.auth.userId] = filteredItems;
  await writeCarts(carts);

  res.json({ items: filteredItems, total: calculateTotal(filteredItems) });
});

app.delete("/api/cart", authRequired, async (req, res) => {
  const carts = await readCarts();
  carts[req.auth.userId] = [];
  await writeCarts(carts);

  res.json({ message: "Cart cleared." });
});

app.get("/api/orders", authRequired, async (req, res) => {
  const orders = await readOrders();
  const userOrders = orders.filter((order) => order.userId === req.auth.userId);
  res.json({ orders: userOrders });
});

app.post("/api/orders", authRequired, async (req, res) => {
  const user = await getCurrentUserById(req.auth.userId);

  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const catalog = await readCatalog();
  const carts = await readCarts();
  const requested = Array.isArray(req.body?.items) && req.body.items.length > 0;
  const items = priceItemsFromCatalog(requested ? req.body.items : carts[req.auth.userId] || [], catalog);

  if (items.length === 0) {
    return res.status(400).json({ message: "Cannot place an order with an empty cart." });
  }

  const subtotal = calculateTotal(items);
  const couponCode = normalizeCouponCode(req.body?.couponCode);
  const coupons = await readCoupons();
  const matchedCoupon = couponCode
    ? coupons.find((coupon) => normalizeCouponCode(coupon.code) === couponCode)
    : null;

  if (couponCode && (!matchedCoupon || !matchedCoupon.active)) {
    return res.status(400).json({ message: "Invalid coupon code." });
  }

  if (matchedCoupon && Number(matchedCoupon.minSubtotal || 0) > subtotal) {
    return res
      .status(400)
      .json({ message: `Coupon requires minimum subtotal of $${matchedCoupon.minSubtotal}.` });
  }

  const discount = matchedCoupon ? calculateCouponDiscount(matchedCoupon, subtotal) : 0;
  const total = Math.max(0, subtotal - discount);
  // FIX: only keep the delivery fields we expect, as short plain strings.
  const rawDelivery = req.body?.delivery && typeof req.body.delivery === "object" ? req.body.delivery : {};
  const delivery = {
    address: String(rawDelivery.address || "").trim().slice(0, 200),
    city: String(rawDelivery.city || "").trim().slice(0, 100),
    country: String(rawDelivery.country || "").trim().slice(0, 100)
  };
  const allowedPaymentMethods = ["cash-on-delivery", "credit-card", "paypal", "bank-transfer"];
  const requestedPayment = String(req.body?.paymentMethod || "cash-on-delivery").trim().toLowerCase();
  const paymentMethod = allowedPaymentMethods.includes(requestedPayment) ? requestedPayment : "cash-on-delivery";

  const order = {
    id: orderId(),
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    createdAt: new Date().toISOString(),
    status: "pending",
    items,
    subtotal,
    discount,
    total,
    coupon: matchedCoupon
      ? {
          code: normalizeCouponCode(matchedCoupon.code),
          type: matchedCoupon.type,
          value: Number(matchedCoupon.value || 0)
        }
      : null,
    delivery,
    paymentMethod
  };

  const orders = await readOrders();
  orders.unshift(order);
  await writeOrders(orders);

  carts[req.auth.userId] = [];
  await writeCarts(carts);

  res.status(201).json({ order });
});

app.post("/api/orders/:orderId/reorder", authRequired, async (req, res) => {
  const sourceOrderId = String(req.params.orderId || "").trim();
  const orders = await readOrders();
  const sourceOrder = orders.find(
    (order) => order.id === sourceOrderId && order.userId === req.auth.userId
  );

  if (!sourceOrder) {
    return res.status(404).json({ message: "Order not found." });
  }

  // FIX: re-ordering now uses today's catalog prices, and no longer copies the old coupon discount
  // while recalculating the total (the old order said "discount 202" but charged the full price).
  const catalog = await readCatalog();
  const clonedItems = priceItemsFromCatalog(sourceOrder.items || [], catalog);
  const subtotal = calculateTotal(clonedItems);

  const newOrder = {
    id: orderId(),
    userId: sourceOrder.userId,
    userEmail: sourceOrder.userEmail,
    userName: sourceOrder.userName,
    createdAt: new Date().toISOString(),
    status: "pending",
    items: clonedItems,
    subtotal,
    discount: 0,
    total: subtotal,
    coupon: null,
    delivery: sourceOrder.delivery || null,
    paymentMethod: sourceOrder.paymentMethod || "cash-on-delivery",
    reorderedFrom: sourceOrder.id
  };

  orders.unshift(newOrder);
  await writeOrders(orders);

  res.status(201).json({ order: newOrder });
});

app.get("/api/admin/orders", authRequired, requirePermission("orders.view"), async (_req, res) => {
  const orders = (await readOrders()).map((order) => ({
    ...order,
    status: String(order.status || "pending").toLowerCase()
  }));
  res.json({ orders, count: orders.length });
});

app.patch("/api/admin/orders/:orderId/status", authRequired, requirePermission("orders.update"), async (req, res) => {
  const orderIdParam = String(req.params.orderId || "").trim();
  const nextStatus = String(req.body?.status || "").trim().toLowerCase();

  if (!ORDER_STATUSES.includes(nextStatus)) {
    return res.status(400).json({
      message: `Invalid status. Allowed: ${ORDER_STATUSES.join(", ")}.`
    });
  }

  const orders = await readOrders();
  const orderIndex = orders.findIndex((order) => order.id === orderIdParam);

  if (orderIndex === -1) {
    return res.status(404).json({ message: "Order not found." });
  }

  const currentOrder = orders[orderIndex];
  orders[orderIndex] = {
    ...currentOrder,
    status: nextStatus,
    updatedAt: new Date().toISOString()
  };

  await writeOrders(orders);
  res.json({ order: orders[orderIndex] });
});

// ---------- Customers and team (admin panel) ----------

function teamMember(user, orders) {
  const access = accessFor(user);
  const own = orders.filter((order) => order.userId === user.id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    role: access.role,
    accessLevel: accessLevel(access),
    permissions: access.permissions,
    locked: access.locked,
    orderCount: own.length,
    totalSpent: own.reduce((sum, order) => sum + Number(order.total || 0), 0),
    accessUpdatedAt: user.accessUpdatedAt || null,
    accessUpdatedBy: user.accessUpdatedBy || null
  };
}

app.get("/api/admin/users", authRequired, requirePermission("customers.view", TEAM_PERMISSION), async (_req, res) => {
  const [users, orders] = await Promise.all([readUsers(), readOrders()]);
  const list = users.map((user) => teamMember(user, orders));
  res.json({ users: list, count: list.length, permissions: ADMIN_PERMISSIONS });
});

function parseAccessChange(body) {
  const level = String(body?.accessLevel || "").trim().toLowerCase();

  if (level === "none") {
    return { role: "customer", permissions: [] };
  }
  if (level === "super") {
    return { role: "superadmin", permissions: [] };
  }
  if (level === "full") {
    return { role: "admin", permissions: [...ADMIN_PERMISSIONS] };
  }
  if (level === "limited") {
    const requested = Array.isArray(body?.permissions) ? body.permissions.map(String) : [];
    const permissions = ADMIN_PERMISSIONS.filter((permission) => requested.includes(permission));
    if (permissions.length === 0) {
      throw httpError(400, "Choose at least one permission for a limited admin.");
    }
    return { role: "admin", permissions };
  }
  throw httpError(400, "Access level must be one of: none, limited, full, super.");
}

async function changeAccess(req, res, findUser) {
  const change = parseAccessChange(req.body);
  const [users, orders] = await Promise.all([readUsers(), readOrders()]);
  const index = users.findIndex(findUser);

  if (index === -1) {
    return res.status(404).json({
      message: "No account found. The person needs to create an account on the shop first."
    });
  }

  const target = users[index];

  if (target.id === req.admin.id) {
    return res.status(400).json({ message: "You can't change your own access." });
  }

  if (accessFor(target).locked) {
    return res.status(400).json({
      message: "This person's access is set in the server settings (SUPER_ADMIN_EMAILS or ADMIN_EMAILS) and can't be changed here."
    });
  }

  users[index] = {
    ...target,
    role: change.role,
    permissions: change.role === "admin" ? change.permissions : [],
    accessUpdatedAt: new Date().toISOString(),
    accessUpdatedBy: req.admin.email
  };

  await writeUsers(users);
  res.json({ user: teamMember(users[index], orders) });
}

// Add or change an admin by email (Team tab "Add admin")
app.post("/api/admin/team", authRequired, requirePermission(TEAM_PERMISSION), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }
  return changeAccess(req, res, (user) => normalizeEmail(user.email) === email);
});

// Change or remove an existing admin
app.patch("/api/admin/team/:userId", authRequired, requirePermission(TEAM_PERMISSION), async (req, res) => {
  const userId = String(req.params.userId || "").trim();
  return changeAccess(req, res, (user) => user.id === userId);
});

app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Request body is not valid JSON." });
  }

  if (error?.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large." });
  }

  if (error?.expose && error.status) {
    return res.status(error.status).json({ message: error.message });
  }

  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

app.listen(PORT, () => {
  console.log(`ProTech backend listening on http://localhost:${PORT}`);
});
