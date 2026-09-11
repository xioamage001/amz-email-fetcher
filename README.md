# 亚马逊广告邮箱自动拉取（多租户版）

每天定时从各租户的邮箱拉取亚马逊搜索词报告，自动存入Supabase数据库。

## 工作原理

```
GitHub Actions 每天22:00触发
    ↓
从Supabase读取所有启用了邮箱拉取的租户配置
    ↓
循环每个租户，用各自的邮箱+授权码连接IMAP拉取报告
    ↓
按租户ID隔离存入 amazon_ads_daily_reports 表
```

## 多租户数据隔离

- 每个租户在系统设置页配置自己的邮箱（邮箱地址、授权码、IMAP服务器）
- 配置存在 `amazon_ads_user_configs` 表的 `email_config` 字段，按 `user_id`（=租户code）隔离
- 拉取到的数据存入 `amazon_ads_daily_reports` 表，带 `tenant_id` 字段
- 租户之间数据完全隔离，互不可见

## 租户配置要求

每个租户需要在系统设置页配置：
1. 开启"邮箱自动拉取"开关
2. 填写邮箱地址（如 xxx@163.com）
3. 填写邮箱授权码（不是登录密码）
4. IMAP服务器（默认 imap.163.com:993 SSL）

配置后，GitHub Actions会自动识别并拉取该租户的报告。

## GitHub Secrets 配置

在仓库 Settings → Secrets and variables → Actions 中配置：

| Secret名称 | 说明 |
|---|---|
| `SUPABASE_URL` | Supabase项目URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |

> 注意：邮箱配置不再需要存在Secrets里，直接从数据库按租户读取。

完整的SUPABASE_ANON_KEY：
`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjcW9od21keG5sYnVwYW5jcW9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4Nzg3MzMsImV4cCI6MjEwNDQ1NDczM30.TE5eXH9z6pq2KxfPmZcMDPQGCP67NBYAOtxEWlPocgs`

## 手动触发

在仓库 Actions 页面，选择"亚马逊广告数据每日拉取"workflow，点击 Run workflow。

## 日志说明

运行日志会显示：
- 共找到多少个启用了邮箱拉取的租户
- 每个租户拉取了多少封邮件
- 每个报告处理成功/失败
- 最终汇总统计（成功/失败租户数）

## 修改拉取时间

编辑 `.github/workflows/fetch.yml` 里的 cron 表达式：

```yaml
schedule:
  - cron: '0 14 * * *'  # UTC时间14点 = 北京时间22点
```

北京时间 = UTC时间 + 8小时。

## 常见问题

**Q: 免费额度够用吗？**
A: GitHub免费版每月2000分钟，每次运行约1-2分钟，每天1次，一个月才30-60分钟，完全够用。

**Q: 租户的邮箱授权码安全吗？**
A: 授权码存在Supabase数据库中，按租户隔离。GitHub Actions运行时通过API读取，不会明文输出到日志。

**Q: 新租户怎么启用自动拉取？**
A: 新租户在系统设置页开启"邮箱自动拉取"，填写邮箱和授权码即可。下次GitHub Actions运行时会自动识别并拉取。

**Q: 怎么确认数据存进去了？**
A: 租户登录系统后，看历史日期里有没有新的数据。数据按tenant_id隔离，每个租户只能看到自己的。
