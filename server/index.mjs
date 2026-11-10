import 'dotenv/config';
import { createService } from './app.mjs';
const service = await createService();
console.log(`AnswerBridge ${service.config.mode} 服务已启动：${service.baseUrl}。请通过桌面客户端创建配对。`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
