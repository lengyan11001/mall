require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createPool } = require("../src/mysql-store");

function firstImage(product) {
  return Array.isArray(product.images) ? product.images[0] || "" : "";
}

function mysqlDate(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  const pool = createPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO app_settings (id, commission_level_1, commission_level_2, min_withdrawal, compliance_name, auto_pay_enabled)
       VALUES (1, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         commission_level_1 = VALUES(commission_level_1),
         commission_level_2 = VALUES(commission_level_2),
         min_withdrawal = VALUES(min_withdrawal),
         compliance_name = VALUES(compliance_name),
         auto_pay_enabled = VALUES(auto_pay_enabled)`,
      [
        seed.settings.commission_level_1,
        seed.settings.commission_level_2,
        seed.settings.min_withdrawal,
        seed.settings.compliance_name,
        seed.settings.auto_pay_enabled ? 1 : 0
      ]
    );

    for (const user of seed.users) {
      await conn.query(
        `INSERT INTO users (id, openid, phone, nickname, avatar, parent_id, first_parent_id, distributor_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           phone = VALUES(phone), nickname = VALUES(nickname), avatar = VALUES(avatar),
           parent_id = VALUES(parent_id),
           first_parent_id = COALESCE(users.first_parent_id, VALUES(first_parent_id)),
           distributor_status = VALUES(distributor_status)`,
        [
          user.id,
          user.openid,
          user.phone,
          user.nickname,
          user.avatar,
          user.parent_id,
          user.first_parent_id || user.parent_id || null,
          user.distributor_status,
          mysqlDate(user.created_at)
        ]
      );
    }

    for (const product of seed.products) {
      await conn.query(
        `INSERT INTO products (id, title, category, price, stock, sales, status, commission_rate, image_url, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), category = VALUES(category), price = VALUES(price),
           stock = VALUES(stock), sales = VALUES(sales), status = VALUES(status),
           commission_rate = VALUES(commission_rate), image_url = VALUES(image_url),
           description = VALUES(description)`,
        [
          product.id,
          product.title,
          product.category,
          product.price,
          product.stock,
          product.sales,
          product.status,
          product.commission_rate,
          firstImage(product),
          product.description,
          mysqlDate(product.created_at)
        ]
      );
    }

    for (const order of seed.orders) {
      await conn.query(
        `INSERT INTO orders (id, user_id, product_id, quantity, amount, status, address, logistics_no, created_at, paid_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status), logistics_no = VALUES(logistics_no), received_at = VALUES(received_at)`,
        [
          order.id,
          order.user_id,
          order.product_id,
          order.quantity,
          order.amount,
          order.status,
          order.address,
          order.logistics_no,
          mysqlDate(order.created_at),
          mysqlDate(order.paid_at),
          mysqlDate(order.received_at)
        ]
      );
    }

    for (const commission of seed.commissions) {
      await conn.query(
        `INSERT INTO commissions (id, order_id, beneficiary_id, buyer_id, level, amount, status, created_at, available_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), amount = VALUES(amount), available_at = VALUES(available_at)`,
        [
          commission.id,
          commission.order_id,
          commission.beneficiary_id,
          commission.buyer_id,
          commission.level,
          commission.amount,
          commission.status,
          mysqlDate(commission.created_at),
          mysqlDate(commission.available_at)
        ]
      );
    }

    for (const withdrawal of seed.withdrawals) {
      await conn.query(
        `INSERT INTO withdrawals (id, user_id, amount, status, note, created_at, reviewed_at, review_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), review_note = VALUES(review_note), reviewed_at = VALUES(reviewed_at)`,
        [
          withdrawal.id,
          withdrawal.user_id,
          withdrawal.amount,
          withdrawal.status,
          withdrawal.note,
          mysqlDate(withdrawal.created_at),
          mysqlDate(withdrawal.reviewed_at),
          withdrawal.review_note
        ]
      );
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
  console.log("Seed data imported");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
