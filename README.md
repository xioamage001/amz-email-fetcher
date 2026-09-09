# 亚马逊广告数据每日自动拉取（GitHub Actions版）

每天北京时间22点自动从邮箱拉取亚马逊搜索词报告，解析后存到Supabase数据库。

## 功能特点

- ✅ 完全免费（GitHub Actions免费额度）
- ✅ 不需要开电脑，GitHub云端自动运行
- ✅ 支持163邮箱（已处理IMAP ID标识问题）
- ✅ 自动去重合并（同一天的多份报告合并）
- ✅ 失败自动发邮件通知
- ✅ 支持手动触发测试

## 部署步骤（5分钟搞定）

### 第一步：注册GitHub账号

1. 打开 https://github.com
2. 点击 Sign up 注册账号（免费）
3. 验证邮箱

### 第二步：创建仓库

1. 登录后点击右上角 `+` → `New repository`
2. Repository name 填：`amz-email-fetcher`
3. 选 `Public`（公开，免费版也能用Actions）
4. 勾选 `Add a README file`
5. 点击 `Create repository`

### 第三步：上传文件

1. 在仓库页面点击 `Add file` → `Upload files`
2. 把这个文件夹里的所有文件拖进去（包括 `.github` 文件夹）
   - index.js
   - config.js
   - package.json
   - .gitignore
   - .github/workflows/fetch.yml
3. 底部点击 `Commit changes`

### 第四步：配置密钥（Secrets）

1. 在仓库页面点击 `Settings`
2. 左侧菜单找到 `Secrets and variables` → `Actions`
3. 点击 `New repository secret`，逐个添加以下密钥：

| Name（名称） | Value（值） | 说明 |
|---|---|---|
| `EMAIL_USER` | `mahejun163@163.com` | 你的邮箱地址 |
| `EMAIL_PASSWORD` | `YP3Phh6SG99FZief` | 邮箱授权码（不是登录密码） |
| `EMAIL_HOST` | `imap.163.com` | IMAP服务器 |
| `EMAIL_PORT` | `993` | IMAP端口 |
| `SUPABASE_URL` | `https://tcqohwmdxnlbupancqor.supabase.co` | Supabase项目URL |
| `SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | Supabase anon key |
| `SUPABASE_USER_ID` | `mahejun126` | 用户标识 |
| `FILTER_SENDER` | `amazon` | 发件人筛选关键词 |
| `FILTER_SUBJECT` | `Search term` | 主题筛选关键词 |
| `FILTER_DAYS` | `7` | 搜索最近几天的邮件 |
| `TABLE_NAME` | `amazon_ads_daily_data` | 数据库表名 |

> 注意：SUPABASE_ANON_KEY 的完整值是：
> `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjcW9od21keG5sYnVwYW5jcW9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4Nzg3MzMsImV4cCI6MjEwNDQ1NDczM30.TE5eXH9z6pq2KxfPmZcMDPQGCP67NBYAOtxEWlPocgs`

### 第五步：手动测试一次

1. 点击仓库顶部的 `Actions` 标签
2. 左侧选 `亚马逊广告数据每日拉取`
3. 点击 `Run workflow` → 选 `main` 分支 → 点击 `Run workflow`
4. 等1-2分钟，看运行结果
5. 如果显示绿色对勾，说明成功了
6. 如果失败，点进去看日志，把错误发我

### 第六步：完成

从此以后，每天北京时间22点自动运行，不需要你做任何事。

## 查看运行记录

1. 仓库页面 → `Actions` 标签
2. 可以看到每次运行的状态、日志、耗时
3. 失败会自动发邮件到你的GitHub注册邮箱

## 修改拉取时间

如果想改时间，编辑 `.github/workflows/fetch.yml` 里的 cron 表达式：

```yaml
schedule:
  - cron: '0 14 * * *'  # UTC时间14点 = 北京时间22点
```

北京时间 = UTC时间 + 8小时，所以：
- 北京时间22点 = UTC 14点 → `0 14 * * *`
- 北京时间早上8点 = UTC 0点 → `0 0 * * *`
- 北京时间中午12点 = UTC 4点 → `0 4 * * *`

## 换邮箱怎么办？

如果以后换邮箱（比如换成QQ邮箱、Gmail）：
1. 在 Settings → Secrets 里更新 `EMAIL_USER`、`EMAIL_PASSWORD`、`EMAIL_HOST`、`EMAIL_PORT`
2. 常见邮箱IMAP配置：
   - 163邮箱：imap.163.com:993
   - QQ邮箱：imap.qq.com:993
   - Gmail：imap.gmail.com:993
   - Outlook：imap-mail.outlook.com:993

## 常见问题

**Q: 免费额度够用吗？**
A: GitHub免费版每月2000分钟，每次运行约1分钟，每天1次，一个月才30分钟，完全够用。

**Q: 会泄露我的邮箱密码吗？**
A: 不会。Secrets是加密存储的，只有Actions运行时才能读取，连你自己都看不到明文。

**Q: 报告邮件在垃圾邮箱里怎么办？**
A: 脚本默认只搜收件箱。如果亚马逊报告在垃圾邮箱，需要在邮箱里设置过滤器，把亚马逊的邮件标记为非垃圾邮件。

**Q: 一天收到多份报告怎么办？**
A: 脚本会按报告日期去重，同一天只保留最新的一份，并且和已有数据合并去重。

**Q: 怎么确认数据存进去了？**
A: 打开你的亚马逊广告AI分析助手应用，看历史日期里有没有新的数据。
