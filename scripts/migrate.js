require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { dbConfig } = require("../src/mysql-store");

async function main() {
  const database = process.env.DB_NAME || "mall";
  const root = await mysql.createConnection(dbConfig({ withoutDatabase: true }));
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await root.end();

  const conn = await mysql.createConnection(dbConfig());
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const statements = schema
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await conn.query(statement);
  }
  await addColumnIfMissing(conn, "users", "session_token", "CHAR(64) NULL");
  await addColumnIfMissing(conn, "users", "session_key_cipher", "VARCHAR(255) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "users", "first_parent_id", "BIGINT UNSIGNED NULL AFTER parent_id");
  await conn.query("UPDATE users SET first_parent_id = parent_id WHERE first_parent_id IS NULL AND parent_id IS NOT NULL");
  await addIndexIfMissing(conn, "users", "uk_users_session_token", "UNIQUE KEY uk_users_session_token (session_token)");
  await addIndexIfMissing(conn, "users", "idx_users_first_parent", "KEY idx_users_first_parent (first_parent_id)");
  await addForeignKeyIfMissing(
    conn,
    "users",
    "fk_users_first_parent",
    "FOREIGN KEY (first_parent_id) REFERENCES users(id) ON DELETE SET NULL"
  );
  await migrateProducts(conn);
  await migrateAcquisition(conn);
  await migrateAddresses(conn);
  await migrateScreenHeartbeats(conn);
  await migratePayments(conn);
  await conn.end();
  console.log(`Migrated database ${database}`);
}

async function migrateProducts(conn) {
  await addColumnIfMissing(conn, "products", "subtitle", "VARCHAR(255) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "products", "product_no", "VARCHAR(64) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "products", "barcode", "VARCHAR(64) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "products", "brand", "VARCHAR(64) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "products", "unit", "VARCHAR(16) NOT NULL DEFAULT '件'");
  await addColumnIfMissing(conn, "products", "market_price", "DECIMAL(10, 2) NOT NULL DEFAULT 0.00");
  await addColumnIfMissing(conn, "products", "cost_price", "DECIMAL(10, 2) NOT NULL DEFAULT 0.00");
  await addColumnIfMissing(conn, "products", "images_json", "JSON NULL");
  await addColumnIfMissing(conn, "products", "detail_html", "MEDIUMTEXT NULL");
  await addColumnIfMissing(conn, "products", "weight", "DECIMAL(10, 3) NOT NULL DEFAULT 0.000");
  await addColumnIfMissing(conn, "products", "min_buy_qty", "INT UNSIGNED NOT NULL DEFAULT 1");
  await addColumnIfMissing(conn, "products", "per_order_limit", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "products", "per_user_limit", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "products", "is_virtual", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "products", "no_refund_after_pay", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "products", "freight_template", "VARCHAR(80) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "products", "delivery_methods", "JSON NULL");
  await addColumnIfMissing(conn, "products", "vip_enabled", "TINYINT(1) NOT NULL DEFAULT 1");
  await addIndexIfMissing(conn, "products", "idx_products_no", "KEY idx_products_no (product_no)");
  await addIndexIfMissing(conn, "products", "idx_products_barcode", "KEY idx_products_barcode (barcode)");
  await conn.query(
    `UPDATE products
     SET market_price = CASE WHEN market_price = 0 THEN price ELSE market_price END,
         cost_price = CASE WHEN cost_price = 0 THEN price ELSE cost_price END,
         images_json = CASE
           WHEN images_json IS NULL AND image_url <> '' THEN JSON_ARRAY(image_url)
           ELSE images_json
         END,
         delivery_methods = CASE
           WHEN delivery_methods IS NULL THEN JSON_ARRAY('express')
           ELSE delivery_methods
         END`
  );
}

async function migrateAcquisition(conn) {
  await addColumnIfMissing(conn, "acquisition_campaigns", "direct_pay_way", "ENUM('wechat_balance') NOT NULL DEFAULT 'wechat_balance'");
  await addColumnIfMissing(conn, "acquisition_campaigns", "lottery_enabled", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "acquisition_campaigns", "lottery_config", "JSON NULL");
  await addColumnIfMissing(conn, "acquisition_campaigns", "qrcode_guide_image", "VARCHAR(600) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "acquisition_campaigns", "team_qrcode_enabled", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "acquisition_campaigns", "team_qrcode_types", "JSON NULL");
  await addColumnIfMissing(conn, "acquisition_campaigns", "traffic_config", "JSON NULL");
  await addColumnIfMissing(conn, "acquisition_campaigns", "share_timeline_text", "VARCHAR(255) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "acquisition_campaigns", "customer_service_qrcode", "VARCHAR(600) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "acquisition_campaigns", "background_music", "VARCHAR(600) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "acquisition_campaigns", "poster_config", "JSON NULL");
  await addColumnIfMissing(conn, "acquisition_campaigns", "virtual_sold_count", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "acquisition_campaigns", "virtual_share_count", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "acquisition_campaigns", "virtual_browse_count", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "acquisition_campaigns", "virtual_invite_count", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing(conn, "acquisition_campaigns", "virtual_rankings", "JSON NULL");
  await addColumnIfMissing(conn, "acquisition_orders", "scene", "VARCHAR(64) NOT NULL DEFAULT '' AFTER form_values");
}

async function migrateAddresses(conn) {
  await addColumnIfMissing(conn, "orders", "address_id", "BIGINT UNSIGNED NULL AFTER address");
  await addIndexIfMissing(conn, "orders", "idx_orders_address", "KEY idx_orders_address (address_id)");
  await addForeignKeyIfMissing(
    conn,
    "orders",
    "fk_orders_address",
    "FOREIGN KEY (address_id) REFERENCES user_addresses(id) ON DELETE SET NULL"
  );
}

async function migrateScreenHeartbeats(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS screen_heartbeats (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      campaign_id BIGINT UNSIGNED NULL,
      product_id BIGINT UNSIGNED NULL,
      scene VARCHAR(64) NOT NULL DEFAULT '',
      page VARCHAR(40) NOT NULL DEFAULT '',
      session_key VARCHAR(96) NOT NULL,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_screen_heartbeat_session (session_key),
      KEY idx_screen_heartbeat_seen (last_seen_at),
      KEY idx_screen_heartbeat_campaign_seen (campaign_id, last_seen_at),
      KEY idx_screen_heartbeat_product_seen (product_id, last_seen_at),
      CONSTRAINT fk_screen_heartbeat_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_screen_heartbeat_campaign FOREIGN KEY (campaign_id) REFERENCES acquisition_campaigns(id) ON DELETE CASCADE,
      CONSTRAINT fk_screen_heartbeat_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await addColumnIfMissing(conn, "screen_heartbeats", "scene", "VARCHAR(64) NOT NULL DEFAULT ''");
  await addColumnIfMissing(conn, "screen_heartbeats", "page", "VARCHAR(40) NOT NULL DEFAULT ''");
  await addIndexIfMissing(conn, "screen_heartbeats", "idx_screen_heartbeat_seen", "KEY idx_screen_heartbeat_seen (last_seen_at)");
  await addIndexIfMissing(conn, "screen_heartbeats", "idx_screen_heartbeat_campaign_seen", "KEY idx_screen_heartbeat_campaign_seen (campaign_id, last_seen_at)");
  await addIndexIfMissing(conn, "screen_heartbeats", "idx_screen_heartbeat_product_seen", "KEY idx_screen_heartbeat_product_seen (product_id, last_seen_at)");
}

async function migratePayments(conn) {
  await addColumnIfMissing(conn, "orders", "pay_provider", "VARCHAR(32) NOT NULL DEFAULT '' AFTER status");
  await addColumnIfMissing(conn, "orders", "out_trade_no", "VARCHAR(64) NULL AFTER pay_provider");
  await addColumnIfMissing(conn, "orders", "transaction_id", "VARCHAR(64) NOT NULL DEFAULT '' AFTER out_trade_no");
  await addColumnIfMissing(conn, "orders", "prepay_id", "VARCHAR(128) NOT NULL DEFAULT '' AFTER transaction_id");
  await conn.query("ALTER TABLE orders MODIFY out_trade_no VARCHAR(64) NULL");
  await conn.query("UPDATE orders SET out_trade_no = NULL WHERE out_trade_no = ''");
  await widenOrderStatusIfNeeded(conn);
  await addIndexIfMissing(conn, "orders", "uk_orders_out_trade_no", "UNIQUE KEY uk_orders_out_trade_no (out_trade_no)");
  await addIndexIfMissing(conn, "orders", "idx_orders_transaction", "KEY idx_orders_transaction (transaction_id)");
}

async function widenOrderStatusIfNeeded(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE column_type
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'status'`
  );
  const type = rows[0]?.column_type || "";
  if (!type.includes("'unpaid'") || !type.includes("'closed'")) {
    await conn.query(
      "ALTER TABLE orders MODIFY status ENUM('unpaid','paid','shipped','received','refunded','closed') NOT NULL DEFAULT 'unpaid'"
    );
  }
}

async function addColumnIfMissing(conn, tableName, columnName, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  if (!Number(rows[0].count)) {
    await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  }
}

async function addIndexIfMissing(conn, tableName, indexName, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [tableName, indexName]
  );
  if (!Number(rows[0].count)) {
    await conn.query(`ALTER TABLE \`${tableName}\` ADD ${definition}`);
  }
}

async function addForeignKeyIfMissing(conn, tableName, constraintName, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [tableName, constraintName]
  );
  if (!Number(rows[0].count)) {
    await conn.query(`ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${constraintName}\` ${definition}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
