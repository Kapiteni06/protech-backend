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
$env:JWT_SECRET="replace-with-a-strong-random-secret"
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

### Dev
- `POST /api/dev/make-admin` body: `{ "email": "..." }`

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
	- `JWT_SECRET` = strong random secret
5. Optional env vars:
	- `PORT` (Render provides this automatically)
	- `GOOGLE_CLIENT_ID` (if you use Google login)
	- `ADMIN_EMAILS` (comma-separated admin emails)
6. Keep frontend requests pointed to the backend using `window.PROTECH_API_BASE_URL` for split deployments.

Auth smoke test commands:

```powershell
$email = "render_test_$(Get-Date -Format 'yyyyMMddHHmmss')@example.com"
$regBody = @{ name = 'Render Test'; email = $email; password = 'secret123' } | ConvertTo-Json
$register = Invoke-RestMethod -Method Post -Uri 'http://localhost:4000/api/auth/register' -ContentType 'application/json' -Body $regBody
$loginBody = @{ email = $email; password = 'secret123' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:4000/api/auth/login' -ContentType 'application/json' -Body $loginBody
$me = Invoke-RestMethod -Method Get -Uri 'http://localhost:4000/api/auth/me' -Headers @{ Authorization = "Bearer $($login.token)" }
```
 