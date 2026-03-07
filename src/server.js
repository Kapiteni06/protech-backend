const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs/promises");
const path = require("path");
const { readDataset, writeDataset } = require("./database");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
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
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "admin@protech.com")
  .split(",")
  .map((email) => normalizeEmail(email))
  .filter(Boolean);
const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];
let mailTransporterPromise = null;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function sanitizeUser(user) {
  const role = user.role || "customer";

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    role,
    isAdmin: role === "admin" || ADMIN_EMAILS.includes(normalizeEmail(user.email))
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

async function writeJson(filePath, value) {
  const datasetKey = datasetKeyFromPath(filePath);
  await writeDataset(datasetKey, value);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
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
    price: 15,
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
  return readJson(PRODUCTS_FILE, DEFAULT_PRODUCTS);
}

async function readReviews() {
  return readJson(REVIEWS_FILE, []);
}

async function writeReviews(reviews) {
  await writeJson(REVIEWS_FILE, reviews);
}

async function readCoupons() {
  return readJson(COUPONS_FILE, DEFAULT_COUPONS);
}

function normalizeProduct(product) {
  const image = String(product?.image || "").trim();

  return {
    id: String(product?.id || "").trim(),
    name: String(product?.name || "").trim(),
    brand: String(product?.brand || "").trim(),
    category: String(product?.category || "").trim().toLowerCase(),
    price: Number(product?.price || 0),
    description: String(product?.description || "").trim(),
    image: image || productImageFallback(product)
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

function productImageFallback(product) {
  const label = encodeURIComponent(String(product?.name || "Product").trim() || "Product");
  return `https://via.placeholder.com/250x200?text=${label}`;
}

function isAdminUser(user) {
  return Boolean(user && (user.role === "admin" || ADMIN_EMAILS.includes(normalizeEmail(user.email))));
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
  next();
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
  const minPrice = Number(req.query.minPrice || 0);
  const maxPrice = Number(req.query.maxPrice || Number.POSITIVE_INFINITY);
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

app.post("/api/products/:productId/reviews", authRequired, async (req, res) => {
  const productId = String(req.params.productId || "").trim();
  const rating = Math.floor(Number(req.body?.rating || 0));
  const comment = String(req.body?.comment || "").trim();

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }

  if (comment.length < 3) {
    return res.status(400).json({ message: "Comment must be at least 3 characters." });
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

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters." });
  }

  const users = await readUsers();
  const existing = users.find((user) => normalizeEmail(user.email) === email);

  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const isAdmin = ADMIN_EMAILS.includes(email);
  const user = {
    id: uuidv4(),
    name,
    email,
    passwordHash,
    role: isAdmin ? "admin" : "customer",
    createdAt: new Date().toISOString()
  };

  users.push(user);
  await writeUsers(users);

  const emailSent = await sendWelcomeEmail(user);

  const token = signToken(user);
  res.status(201).json({ user: sanitizeUser(user), token, emailSent });
});

app.post("/api/auth/register", registerHandler);
app.post("/api/auth/signup", registerHandler);

app.post("/api/auth/google", asyncHandler(async (req, res) => {
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
    const isAdmin = ADMIN_EMAILS.includes(email);

    if (existingIndex === -1) {
      const newUser = {
        id: uuidv4(),
        name: name.length >= 2 ? name : "Google User",
        email,
        authProvider: "google",
        role: isAdmin ? "admin" : "customer",
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
      role: isAdmin ? "admin" : existingUser.role || "customer"
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

app.post("/api/auth/login", loginHandler);
app.post("/api/auth/signin", loginHandler);

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

app.post("/api/dev/make-admin", async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Valid email is required." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((user) => normalizeEmail(user.email) === email);

  if (userIndex === -1) {
    return res.status(404).json({ message: "User not found." });
  }

  users[userIndex].role = "admin";
  await writeUsers(users);

  res.json({
    message: `User ${email} is now admin. Please sign out and sign in again.`,
    user: sanitizeUser(users[userIndex])
  });
});

app.put("/api/profile", authRequired, async (req, res) => {
  const nextName = String(req.body?.name || "").trim();

  if (nextName.length < 2) {
    return res.status(400).json({ message: "Name must be at least 2 characters." });
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

  if (newPassword.length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((user) => user.id === req.auth.userId);

  if (userIndex === -1) {
    return res.status(404).json({ message: "User not found." });
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
  const items = normalizeCartItems(req.body?.items || []);
  const carts = await readCarts();

  carts[req.auth.userId] = items;
  await writeCarts(carts);

  res.json({ items, total: calculateTotal(items) });
});

app.post("/api/cart/items", authRequired, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const price = Number(req.body?.price || 0);
  const quantity = Math.max(1, Math.floor(Number(req.body?.quantity || 1)));

  if (!name) {
    return res.status(400).json({ message: "Item name is required." });
  }

  if (price < 0) {
    return res.status(400).json({ message: "Item price cannot be negative." });
  }

  const carts = await readCarts();
  const currentItems = normalizeCartItems(carts[req.auth.userId] || []);
  const existing = currentItems.find((item) => item.name === name);

  if (existing) {
    existing.quantity += quantity;
  } else {
    currentItems.push({ name, price, quantity });
  }

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

  const carts = await readCarts();
  const cartItems = normalizeCartItems(carts[req.auth.userId] || []);
  const requestedItems = normalizeCartItems(req.body?.items || []);
  const items = requestedItems.length > 0 ? requestedItems : cartItems;

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
  const delivery = req.body?.delivery || null;
  const paymentMethod = String(req.body?.paymentMethod || "cash-on-delivery");

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

  const clonedItems = normalizeCartItems(sourceOrder.items || []);
  const total = calculateTotal(clonedItems);

  const newOrder = {
    ...sourceOrder,
    id: orderId(),
    createdAt: new Date().toISOString(),
    status: "pending",
    items: clonedItems,
    total
  };

  orders.unshift(newOrder);
  await writeOrders(orders);

  res.status(201).json({ order: newOrder });
});

app.get("/api/admin/orders", authRequired, adminRequired, async (_req, res) => {
  const orders = (await readOrders()).map((order) => ({
    ...order,
    status: String(order.status || "pending").toLowerCase()
  }));
  res.json({ orders, count: orders.length });
});

app.patch("/api/admin/orders/:orderId/status", authRequired, adminRequired, async (req, res) => {
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

app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`ProTech backend listening on http://localhost:${PORT}`);
});

