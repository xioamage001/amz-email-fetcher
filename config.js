// 配置文件 - 从环境变量读取（GitHub Actions Secrets）
module.exports = {
  // 邮箱配置
  email: {
    user: process.env.EMAIL_USER || 'mahejun163@163.com',
    password: process.env.EMAIL_PASSWORD || '',
    host: process.env.EMAIL_HOST || 'imap.163.com',
    port: parseInt(process.env.EMAIL_PORT || '993'),
    tls: process.env.EMAIL_TLS !== 'false',
  },

  // Supabase 配置
  supabase: {
    url: process.env.SUPABASE_URL || 'https://tcqohwmdxnlbupancqor.supabase.co',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    userId: process.env.SUPABASE_USER_ID || 'mahejun126',
  },

  // 邮件筛选条件
  filter: {
    sender: process.env.FILTER_SENDER || 'amazon',
    subject: process.env.FILTER_SUBJECT || 'Search term',
    days: parseInt(process.env.FILTER_DAYS || '7'),
  },

  // 数据存储表名
  tableName: process.env.TABLE_NAME || 'amazon_ads_daily_data',
};
