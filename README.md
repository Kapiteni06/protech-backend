# ProTech Backend

Node/Express backend for your `protech` frontend.

## What this backend includes

- JWT auth (register, login, me)
- Profile update + password change
- Cart API (get, replace, add item, remove item, clear)
- Orders API (list, create from cart/items, reorder)
- JSON-file persistence in `data/`

## Project structure

- `src/server.js` - all API routes + middleware
- `data/users.json` - users (with hashed passwords)
- `data/carts.json` - cart items by user id
- `data/orders.json` - placed orders

## Setup

1. Install Node.js LTS (includes `npm`).
2. Open terminal in `protech/backend`.
3. Install dependencies:

```bash
npm install
```

4. (Optional but recommended) set environment variables:

```bash
# PowerShell
$env:PORT="4000"
$env:JWT_SECRET="replace-with-a-random-string-of-at-least-32-characters"
$env:CORS_ORIGINS="https://your-frontend.example.com"
$env:ADMIN_EMAILS="you@example.com"
$env:GOOGLE_CLIENT_ID="your-google-client-id.apps.googleusercontent.com"
$env:SMTP_HOST="smtp.example.com"
$env:SMTP_PORT="587"
$env:SMTP_USER="no-reply@examlpe.com"
$env:SMTP_PASS="your-smtp-password"
$env:SMTP_SECURE="false"
$env:EMAIL_FROM="ProTech <no-reply@example.com>"
```

5. Start backend:

```bash
npm start
```

The API will run at `http://localhost:4000`.

## API summary

### Health
- `GET /api/health`

### Auth
- `POST /api/auth/register` body: `{ "name": "...", "email": "...", "password": "..." }`
- `POST /api/auth/login` body: `{ "email": "...", "password": "..." }`
- `POST /api/auth/google` body: `{ "credential": "<google_id_token>" }`
- `POST /api/auth/logout`
- `GET /api/auth/me` (Bearer token)

Auth notes:
- Register now enforces stricter email format validation.
- Google login only accepts Google accounts with verified emails.
- Register/signup can send a welcome email when SMTP env vars are configured.

### Profile
- `PUT /api/profile` body: `{ "name": "..." }` (Bearer token)
- `PUT /api/profile/password` body: `{ "currentPassword": "...", "newPassword": "..." }` (Bearer token)

### Cart
- `GET /api/cart` (Bearer token)
- `PUT /api/cart` body: `{ "items": [{ "name": "...", "price": 1200, "quantity": 1 }] }` (Bearer token)
- `POST /api/cart/items` body: `{ "name": "...", "price": 1200, "quantity": 1 }` (Bearer token)
- `DELETE /api/cart/items/:name` (Bearer token)
- `DELETE /api/cart` (Bearer token)

### Orders
- `GET /api/orders` (Bearer token)
- `POST /api/orders` body: `{ "delivery": {...}, "paymentMethod": "cash-on-delivery" }` (or include `items`) (Bearer token)
- `POST /api/orders/:orderId/reorder` (Bearer token)

### Admin
- `POST /api/dev/make-admin` body: `{ "email": "..." }` (Bearer token of an existing **admin** — no longer public)

## Frontend integration notes

Frontend now supports dynamic API URL resolution in `auth.js`, `cart.js`, `profile.js`, and `admin.js`.

Resolution order:

1. `window.PROTECH_API_BASE_URL` (if you define it in HTML)
2. `localStorage.protechApiBaseUrl`
3. Local dev fallback: `http://localhost:4000/api` when running on `localhost`
4. Production fallback: `${window.location.origin}/api`

This means:

- Same-domain deploy (frontend + backend behind same host/reverse proxy): no extra config needed.
- Separate frontend/backend deploy on Render: set one of the explicit config values to your backend URL.

Example for separate Render services (add before app scripts in your HTML):

```html
<script>
  window.PROTECH_API_BASE_URL = "https://your-backend-service.onrender.com";
</script>
```

You can also set it in browser once for testing:

```js
localStorage.setItem("protechApiBaseUrl", "https://your-backend-service.onrender.com");
```

## Render deployment checklist

1. Backend service root: `protech/backend`
2. Build command: `npm install`
3. Start command: `npm start`
4. Required env vars:
	- `JWT_SECRET` = random string, at least 32 characters (the server will not start on Render without it)
	- `SMTP_*` + `EMAIL_FROM` if you want password reset to work (the reset token is only ever sent by email)
5. Optional env vars:
	- `PORT` (Render provides this automatically)
	- `GOOGLE_CLIENT_ID` (if you use Google login)
	- `SUPER_ADMIN_EMAILS` (comma-separated; super admins can add, change and remove admins from the admin panel)
	- `ADMIN_EMAILS` (comma-separated full admins; there is no built-in admin email any more)
	- `CORS_ORIGINS` (comma-separated frontend URLs allowed to call the API)
6. Keep frontend requests pointed to the backend using `window.PROTECH_API_BASE_URL` for split deployments.

Auth smoke test commands:

```powershell
$email = "render_test_$(Get-Date -Format 'yyyyMMddHHmmss')@example.com"
$regBody = @{ name = 'Render Test'; email = $email; password = 'secret1234' } | ConvertTo-Json
$register = Invoke-RestMethod -Method Post -Uri 'http://localhost:4000/api/auth/register' -ContentType 'application/json' -Body $regBody
$loginBody = @{ email = $email; password = 'secret1234' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:4000/api/auth/login' -ContentType 'application/json' -Body $loginBody
$me = Invoke-RestMethod -Method Get -Uri 'http://localhost:4000/api/auth/me' -Headers @{ Authorization = "Bearer $($login.token)" }
```
 
## Security notes (October 2026 fixes)

- Prices are always taken from `data/products.json` on the server; the browser only sends which product and how many. Sale prices for the Discounts page live in `SALE_PRICES` in `src/server.js`.
- `data/products.json` and `data/coupons.json` are read directly, so editing them takes effect.
- Passwords for new accounts / resets must be 8+ characters with a letter and a number.
- Sign-in, sign-up, password reset and reviews are rate-limited per IP.
- Requests that change data run one at a time, so simultaneous requests no longer overwrite each other.
- `ALLOW_DEV_RESET_TOKEN=true` returns the reset token in the API response for local testing only; it is ignored in production.

## Admin roles

| Level | Can do |
|---|---|
| Super admin | Everything, including adding, changing and removing admins (Team tab) |
| Full access | View orders, change order status, view customers |
| Limited access | Only the permissions the super admin ticks: view orders, change order status, view customers |

- Super admins come from `SUPER_ADMIN_EMAILS`, or are promoted by another super admin.
- People listed in `SUPER_ADMIN_EMAILS` / `ADMIN_EMAILS` show as "Set on server" and can't be changed from the panel.
- Nobody can change their own access. Changes apply immediately (no need to sign in again).
- API: `GET /api/admin/users`, `POST /api/admin/team` `{ email, accessLevel, permissions }`, `PATCH /api/admin/team/:userId` `{ accessLevel, permissions }`.
  `accessLevel` is `none`, `limited`, `full` or `super`; `permissions` (for limited) is any of `orders.view`, `orders.update`, `customers.view`.
