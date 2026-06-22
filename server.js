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

  const shutdown = async signal => {
    console.log(`Received ${signal}, shutting down...`);
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
