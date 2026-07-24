require("dotenv").config();

const cluster = require("cluster");
const os = require("os");
const { createServer } = require("./src/app");
const { createStore } = require("./src/mysql-store");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4175);

function resolveWorkerCount() {
  const raw = String(process.env.APP_WORKERS || "1").trim().toLowerCase();
  const cpuCount = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  const maxWorkers = Math.max(1, Number(process.env.APP_WORKERS_MAX || 8));
  if (raw === "auto") return Math.max(1, Math.min(cpuCount, maxWorkers));
  const count = Number(raw);
  if (!Number.isInteger(count) || count <= 1) return 1;
  return Math.max(1, Math.min(count, maxWorkers));
}

function startCluster(workerCount) {
  const workerRoles = new Map();
  let shuttingDown = false;

  const forkWorker = runMaintenance => {
    const worker = cluster.fork({
      MALL_CLUSTER_WORKERS: String(workerCount),
      MALL_RUN_MAINTENANCE: runMaintenance ? "1" : "0"
    });
    workerRoles.set(worker.id, runMaintenance);
  };

  console.log(`Starting ${workerCount} mall workers`);
  for (let index = 0; index < workerCount; index += 1) {
    forkWorker(index === 0);
  }

  cluster.on("exit", (worker, code, signal) => {
    const runMaintenance = workerRoles.get(worker.id);
    workerRoles.delete(worker.id);
    if (shuttingDown) return;
    console.error(`Mall worker ${worker.process.pid} exited (${code || signal}), restarting...`);
    forkWorker(runMaintenance);
  });

  const shutdown = signal => {
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down mall cluster...`);
    for (const id of Object.keys(cluster.workers)) {
      cluster.workers[id].disconnect();
    }
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const store = createStore();
  await store.ping();

  const server = createServer({ store });
  server.listen(port, host, () => {
    const worker = cluster.worker ? ` worker ${cluster.worker.id}` : "";
    console.log(`WeChat distribution mall${worker} running at http://${host}:${port}`);
  });

  const runMaintenance = process.env.MALL_RUN_MAINTENANCE !== "0";
  let closingExpiredOrders = false;
  const closeExpiredOrders = async () => {
    if (!runMaintenance || closingExpiredOrders || typeof store.closeExpiredOrders !== "function") return;
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
  const expiredOrderTimer = runMaintenance
    ? setInterval(closeExpiredOrders, Number(process.env.EXPIRED_ORDER_CLOSE_INTERVAL_MS || 60000))
    : null;
  if (expiredOrderTimer) expiredOrderTimer.unref();
  if (runMaintenance) closeExpiredOrders();

  const shutdown = async signal => {
    console.log(`Received ${signal}, shutting down...`);
    if (expiredOrderTimer) clearInterval(expiredOrderTimer);
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const workerCount = resolveWorkerCount();
if (workerCount > 1 && cluster.isPrimary) {
  startCluster(workerCount);
} else {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
