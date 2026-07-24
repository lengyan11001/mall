require("dotenv").config();

const { createServer } = require("./src/app");
const { createStore } = require("./src/mysql-store");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4175);

async function main() {
  const store = createStore();
  await store.ping();

  const server = createServer({ store });
  server.listen(port, host, () => {
    console.log(`WeChat distribution mall running at http://${host}:${port}`);
  });

  let closingExpiredOrders = false;
  const closeExpiredOrders = async () => {
    if (closingExpiredOrders || typeof store.closeExpiredOrders !== "function") return;
    closingExpiredOrders = true;
    try {
      const result = await store.closeExpiredOrders({
        limit: Number(process.env.EXPIRED_ORDER_CLOSE_BATCH || 100)
      });
      if (result.closed_count) {
        console.log(`Closed ${result.closed_count} expired unpaid orders`);
      }
    } catch (error) {
      console.error("Expired order cleanup failed", error);
    } finally {
      closingExpiredOrders = false;
    }
  };
  const expiredOrderTimer = setInterval(closeExpiredOrders, Number(process.env.EXPIRED_ORDER_CLOSE_INTERVAL_MS || 60000));
  expiredOrderTimer.unref();
  closeExpiredOrders();

  const shutdown = async signal => {
    console.log(`Received ${signal}, shutting down...`);
    clearInterval(expiredOrderTimer);
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
