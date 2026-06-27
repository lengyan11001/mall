require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { dbConfig } = require("../src/mysql-store");
const { DEFAULT_LEGACY_APPID } = require("../src/tenant-config");

function legacyAppId() {
  return process.env.WECHAT_LEGACY_APP_ID || DEFAULT_LEGACY_APPID;
}

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
  await migrateTenancy(conn);
  await migrateAdminUsers(conn);
  await conn.end();
  console.log(`Migrated database ${database}`);
}

async function migrateTenancy(conn) {
  const appid = legacyAppId();
  const tables = [
    "users",
    "user_addresses",
    "products",
    "acquisition_campaigns",
    "acquisition_materials",
    "orders",
    "acquisition_orders",
    "acquisition_relations",
    "acquisition_lottery_records",
    "commissions",
    "withdrawals",
    "screen_heartbeats",
    "app_settings"
  ];

  for (const table of tables) {
    await addColumnIfMissing(conn, table, "appid", "VARCHAR(32) NOT NULL DEFAULT '' AFTER id");
    await conn.query(`UPDATE \`${table}\` SET appid = ? WHERE appid = '' OR appid IS NULL`, [appid]);
  }

  await dropIndexIfExists(conn, "users", "uk_users_openid");
  await addIndexIfMissing(conn, "users", "uk_users_appid_openid", "UNIQUE KEY uk_users_appid_openid (appid, openid)");
  await addIndexIfMissing(conn, "users", "idx_users_appid_created", "KEY idx_users_appid_created (appid, created_at)");

  await addIndexIfMissing(conn, "user_addresses", "idx_user_addresses_app_user_default", "KEY idx_user_addresses_app_user_default (appid, user_id, is_default, id)");

  await addIndexIfMissing(conn, "products", "idx_products_app_status_category", "KEY idx_products_app_status_category (appid, status, category)");

  await addIndexIfMissing(conn, "acquisition_campaigns", "idx_acquisition_app_status_time", "KEY idx_acquisition_app_status_time (appid, status, start_at, end_at)");
  await addIndexIfMissing(conn, "acquisition_campaigns", "idx_acquisition_app_product", "KEY idx_acquisition_app_product (appid, product_id)");

  await addIndexIfMissing(conn, "acquisition_materials", "idx_materials_app_type_sort", "KEY idx_materials_app_type_sort (appid, type, sort_order, id)");

  await addIndexIfMissing(conn, "app_settings", "uk_app_settings_appid", "UNIQUE KEY uk_app_settings_appid (appid)");

  await addIndexIfMissing(conn, "orders", "idx_orders_app_user_created", "KEY idx_orders_app_user_created (appid, user_id, created_at)");
  await addIndexIfMissing(conn, "orders", "idx_orders_app_status_created", "KEY idx_orders_app_status_created (appid, status, created_at)");

  await addIndexIfMissing(conn, "acquisition_orders", "idx_acquisition_orders_campaign_app", "KEY idx_acquisition_orders_campaign_app (appid, campaign_id, created_at)");
  await addIndexIfMissing(conn, "acquisition_orders", "idx_acquisition_orders_inviter_app", "KEY idx_acquisition_orders_inviter_app (appid, campaign_id, inviter_id)");

  await dropIndexIfExists(conn, "acquisition_relations", "uk_campaign_member");
  await addIndexIfMissing(conn, "acquisition_relations", "uk_campaign_member", "UNIQUE KEY uk_campaign_member (appid, campaign_id, member_id)");
  await addIndexIfMissing(conn, "acquisition_relations", "idx_relations_inviter_app", "KEY idx_relations_inviter_app (appid, campaign_id, inviter_id)");
  await addIndexIfMissing(conn, "acquisition_relations", "idx_relations_parent_app", "KEY idx_relations_parent_app (appid, campaign_id, parent_inviter_id)");

  await addIndexIfMissing(conn, "acquisition_lottery_records", "idx_lottery_campaign_app", "KEY idx_lottery_campaign_app (appid, campaign_id, created_at)");
  await addIndexIfMissing(conn, "acquisition_lottery_records", "idx_lottery_user_app", "KEY idx_lottery_user_app (appid, user_id, created_at)");

  await addIndexIfMissing(conn, "commissions", "idx_commissions_beneficiary_app", "KEY idx_commissions_beneficiary_app (appid, beneficiary_id, status)");
  await addIndexIfMissing(conn, "commissions", "idx_commissions_buyer_app", "KEY idx_commissions_buyer_app (appid, buyer_id)");

  await addIndexIfMissing(conn, "withdrawals", "idx_withdrawals_user_app", "KEY idx_withdrawals_user_app (appid, user_id, status)");
  await addIndexIfMissing(conn, "withdrawals", "idx_withdrawals_status_app", "KEY idx_withdrawals_status_app (appid, status, created_at)");

  await dropIndexIfExists(conn, "screen_heartbeats", "uk_screen_heartbeat_session");
  await addIndexIfMissing(conn, "screen_heartbeats", "uk_screen_heartbeat_session", "UNIQUE KEY uk_screen_heartbeat_session (appid, session_key)");
  await addIndexIfMissing(conn, "screen_heartbeats", "idx_screen_heartbeat_seen_app", "KEY idx_screen_heartbeat_seen_app (appid, last_seen_at)");
  await addIndexIfMissing(conn, "screen_heartbeats", "idx_screen_heartbeat_campaign_seen_app", "KEY idx_screen_heartbeat_campaign_seen_app (appid, campaign_id, last_seen_at)");
  await addIndexIfMissing(conn, "screen_heartbeats", "idx_screen_heartbeat_product_seen_app", "KEY idx_screen_heartbeat_product_seen_app (appid, product_id, last_seen_at)");
}

async function migrateAdminUsers(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      appid VARCHAR(32) NOT NULL DEFAULT '',
      username VARCHAR(64) NOT NULL,
      password_hash VARCHAR(160) NOT NULL,
      status ENUM('active','disabled') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_admin_users_username (username),
      KEY idx_admin_users_appid (appid, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await addColumnIfMissing(conn, "admin_users", "appid", "VARCHAR(32) NOT NULL DEFAULT '' AFTER id");
  await addColumnIfMissing(conn, "admin_users", "status", "ENUM('active','disabled') NOT NULL DEFAULT 'active'");
  await addIndexIfMissing(conn, "admin_users", "uk_admin_users_username", "UNIQUE KEY uk_admin_users_username (username)");
  await addIndexIfMissing(conn, "admin_users", "idx_admin_users_appid", "KEY idx_admin_users_appid (appid, status)");
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

async function dropIndexIfExists(conn, tableName, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [tableName, indexName]
  );
  if (Number(rows[0].count)) {
    await conn.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
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
