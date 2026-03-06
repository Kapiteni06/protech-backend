-- ProTech phpMyAdmin import generated automatically

-- Generated at: 2026-03-06T21:25:01.735Z

SET NAMES utf8mb4;

SET time_zone = '+00:00';

SET FOREIGN_KEY_CHECKS = 0;


CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(191) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'customer',
  auth_provider VARCHAR(64) NULL,
  created_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(255) NOT NULL,
  category VARCHAR(64) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  description TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS coupons (
  code VARCHAR(64) PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  value DECIMAL(12,2) NOT NULL,
  min_subtotal DECIMAL(12,2) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reviews (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  rating INT NOT NULL,
  comment TEXT NULL,
  created_at DATETIME NULL,
  CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  user_email VARCHAR(255) NULL,
  user_name VARCHAR(255) NULL,
  created_at DATETIME NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  subtotal DECIMAL(12,2) NULL,
  discount DECIMAL(12,2) NULL,
  total DECIMAL(12,2) NULL,
  coupon_json LONGTEXT NULL,
  delivery_json LONGTEXT NULL,
  payment_method VARCHAR(64) NULL,
  updated_at DATETIME NULL,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  quantity INT NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS carts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  UNIQUE KEY uq_carts_user_id (user_id),
  CONSTRAINT fk_carts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cart_items (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cart_id INT NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  quantity INT NOT NULL,
  CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


DELETE FROM cart_items;

DELETE FROM carts;

DELETE FROM order_items;

DELETE FROM orders;

DELETE FROM reviews;

DELETE FROM coupons;

DELETE FROM products;

DELETE FROM users;


INSERT INTO users (id, name, email, password_hash, role, auth_provider, created_at) VALUES
('d3be656b-bf4f-45f4-a0c9-120b881b6481', 'Arben', 'arben@gmail.com', '$2a$10$fZyNDO5um4DobSu6CA88YufBuvcf7Q.KIJBuacrGX8Xr/RHlaNiNm', 'customer', NULL, '2026-03-01 20:18:17'),
('082fcc84-cf14-411d-8c6e-f8d88bb2975e', 'Arben', 'arbendalipi27@gmail.com', '$2a$10$uz6Ac1/OmQdPpOtV.bum4.G.SXIoRqw2mP4zWnblqg9OyoTXK197u', 'customer', NULL, '2026-03-01 20:30:08'),
('5dd35ef5-3489-4a1e-a3dc-5bb0c1a5f6be', 'Admin Test', 'admin-test@protech.com', '$2a$10$Ptb845kULJZAr3qblOj4YeV1KvD4t7Svh8EifYSsczSW.kM5JuPlm', 'admin', NULL, '2026-03-01 20:38:30'),
('4a231eda-31c1-4ec2-9b9f-e6c0b5753ff9', 'beni', 'beni@gmail.com', '$2a$10$KpbQeYkjczXgMLAW4ZeO9..OYQlSdb6f6UV04/BKhhsmW.Tzm4Yz6', 'admin', NULL, '2026-03-01 20:41:58'),
('ae9b63b3-a5b8-4961-958d-6c2abd86883c', 'Copilot Test', 'copilot_test_20260306195854@example.com', '$2a$10$VBdhbOua8Zer9nfLIGpGneoJ0hllLVNXwHai1bAX6183z0YSMb8/i', 'customer', NULL, '2026-03-06 18:58:54'),
('be58abdf-6882-4e56-8af1-8df8e2d1fb55', 'Copilot Test 2', 'copilot_test2_20260306200010@example.com', '$2a$10$Flb8oig0mF56WaEn0ySj5uaH2DHTzZ6dq0dqQQyXg.P4PMde79WbG', 'customer', NULL, '2026-03-06 19:00:10'),
('c9f7c4aa-f2d2-44d9-be2b-edbc80a1b2c1', 'Copilot Test 3', 'copilot_test3_20260306201931@example.com', '$2a$10$/LTDpZK594TC1kbkDUxH2eYh8o0yzw7jYHNNUKQa0WZI0FfHirbm.', 'customer', NULL, '2026-03-06 19:19:31'),
('b2681a92-b8e5-4ea6-b42c-6c1c9fd0b7fe', 'Render Wire', 'render_wire_20260306210315@example.com', '$2a$10$1oJGOLB8Fn4EVOVVJPHLm.9YSeRxIArtzHb..xvF8JU3U1YO3Zur6', 'customer', NULL, '2026-03-06 20:03:15'),
('f67b273f-0111-4f33-973e-e773dd5a9946', 'Sign User', 'signin_signup_20260306215333@example.com', '$2a$10$0Av6VrEY3O5FikJTo/HjXecOTdx8258Ol.njHO10vj4p9AydpLdj2', 'customer', NULL, '2026-03-06 20:53:33');


INSERT INTO products (id, name, brand, category, price, description) VALUES
('iphone-15', 'iPhone 15', 'Apple', 'phone', 999, 'Latest Apple smartphone'),
('samsung-galaxy-s24', 'Samsung Galaxy S24', 'Samsung', 'phone', 899, 'Premium Android phone'),
('google-pixel-8', 'Google Pixel 8', 'Google', 'phone', 799, 'Clean Android experience'),
('xiaomi-14', 'Xiaomi 14', 'Xiaomi', 'phone', 699, 'Flagship features at great value'),
('macbook-pro-16', 'MacBook Pro 16"', 'Apple', 'laptop', 2499, 'Powerful performance laptop'),
('dell-xps-15', 'Dell XPS 15', 'Dell', 'laptop', 1699, 'High-performance ultrabook'),
('lenovo-thinkpad-x1', 'Lenovo ThinkPad X1', 'Lenovo', 'laptop', 1499, 'Business-class reliability'),
('asus-rog-zephyrus', 'ASUS ROG Zephyrus', 'ASUS', 'laptop', 1899, 'Portable gaming powerhouse'),
('gaming-pc-rtx-4090', 'Gaming PC RTX 4090', 'ProTech', 'others', 3299, 'Ultimate gaming machine'),
('smart-watch-pro', 'Smart Watch Pro', 'ProTech', 'others', 299, 'Fitness and notifications on your wrist'),
('wireless-headphones', 'Wireless Headphones', 'ProTech', 'others', 249, 'Noise cancellation and rich sound'),
('mechanical-keyboard', 'Mechanical Keyboard', 'ProTech', 'others', 149, 'Fast response with tactile switches');


INSERT INTO coupons (code, type, value, min_subtotal, active) VALUES
('WELCOME10', 'percent', 10, 50, 1),
('SAVE50', 'fixed', 50, 500, 1);


INSERT INTO reviews (id, product_id, user_id, user_name, rating, comment, created_at) VALUES
('02f279b3-b78b-437c-aeef-ea9d234eed23', 'iphone-15', '5dd35ef5-3489-4a1e-a3dc-5bb0c1a5f6be', 'Admin Test', 5, 'Excellent phone', '2026-03-01 20:38:31');


INSERT INTO orders (id, user_id, user_email, user_name, created_at, status, subtotal, discount, total, coupon_json, delivery_json, payment_method, updated_at) VALUES
('ORD-1772398808151-2016', '4a231eda-31c1-4ec2-9b9f-e6c0b5753ff9', 'beni@gmail.com', 'beni', '2026-03-01 21:00:08', 'pending', 4998, 0, 4998, NULL, '{"address":"ssaS 69","city":"ggg","country":"Kosovo"}', 'cash-on-delivery', NULL),
('ORD-1772398358299-2819', '4a231eda-31c1-4ec2-9b9f-e6c0b5753ff9', 'beni@gmail.com', 'beni', '2026-03-01 20:52:38', 'pending', NULL, NULL, 899, NULL, '{"address":"ssaS 69","city":"ggg","country":"ggg"}', 'cash-on-delivery', NULL),
('ORD-1772397554048-1623', '5dd35ef5-3489-4a1e-a3dc-5bb0c1a5f6be', 'admin-test@protech.com', 'Admin Test', '2026-03-01 20:39:14', 'processing', 999, 100, 899, '{"code":"WELCOME10","type":"percent","value":10}', NULL, 'card', '2026-03-01 20:39:14');


INSERT INTO order_items (order_id, item_name, unit_price, quantity) VALUES
('ORD-1772398808151-2016', 'MacBook Pro 16"', 2499, 2),
('ORD-1772398358299-2819', 'Samsung Galaxy S24', 899, 1),
('ORD-1772397554048-1623', 'iPhone 15', 999, 1);


INSERT INTO carts (id, user_id) VALUES
(1, '5dd35ef5-3489-4a1e-a3dc-5bb0c1a5f6be'),
(2, '4a231eda-31c1-4ec2-9b9f-e6c0b5753ff9');


SET FOREIGN_KEY_CHECKS = 1;

