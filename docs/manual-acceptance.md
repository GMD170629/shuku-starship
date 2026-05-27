# MVP 手工验收清单

1. 访问 `/login`，使用 `admin@example.com` / `starshipnas` 登录。
2. 未登录访问 `/library` 会跳转到登录页，登录后可进入书库。
3. 在 `/settings` 保存一个可读书库路径，例如 Docker 中的 `/books`。
4. 在 `/scan-tasks` 选择书库路径并创建扫描任务，Worker 完成后能看到新增、更新和日志。
5. 在 `/library` 搜索、筛选 TXT/PDF/漫画，点击进入详情页。
6. 从详情页进入阅读器，TXT、PDF、图片/漫画都通过 `/api/files/:fileId` 加载。
7. 翻页或滚动后刷新阅读器，进度能恢复。
8. 在 375px 宽度下检查登录、书库、详情、扫描、设置和阅读器无明显横向溢出。
9. 执行 `docker compose up --build`，确认 Web、MySQL、Redis、Worker 可启动并连接。
