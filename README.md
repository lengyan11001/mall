# WeChat Distribution Mall

`E:/miniapp-plan/plan.html` 对应的必火次元实现。当前版本已从 JSON demo 改为生产取向的 Node.js API + MySQL 8 持久化：

- 用户端：微信登录、商品浏览、拓客宝活动、下单、订单确认、分享海报、推荐关系绑定、佣金明细、提现申请。
- 管理后台：数据看板、完整商品资料、拓客宝活动配置、四种关系绑定模式、引流码、素材模板、订单发货/退款、分销员审核、佣金流水、提现审核、佣金配置。
- 后端：MySQL 连接池、事务、库存行锁、活动库存、活动订单关系、佣金/提现状态索引。微信支付、企业付款、小程序码生成保留正式集成入口。
- 生产环境默认禁用 `/api/auth/login` 开发登录；小程序走 `/api/wechat/login`。如本地预览需要开发登录，可临时设置 `ENABLE_DEV_LOGIN=1`。

## UI Rules

- 复杂配置必须按步骤、Tab 或分区向导承接。不要把互不相同的设置项堆在一个长弹窗里。
- 后台配置页优先使用“基本设置 -> 业务规则 -> 营销玩法 -> 引流/素材 -> 完成确认”的流程，让用户逐步保存和校验。
- 新增营销/活动类功能时，后台配置和前端承接必须同步设计，不能只加字段。

## Run

```bash
npm start
```

- 用户端：http://localhost:4175/
- 管理后台：http://localhost:4175/admin
- 健康检查：http://localhost:4175/api/health

## Database

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm start
```

## Deploy

- App directory: `/opt/mall`
- Domain: `mall.bhzn.top`
- Reverse proxy: `deploy/nginx.mall.bhzn.top.conf`
- systemd service: `deploy/mall.service`

Sensitive values such as `WECHAT_APP_SECRET`, database password, and upload key path must live in `.env` or `/opt/mall/secrets/`; do not commit them.
