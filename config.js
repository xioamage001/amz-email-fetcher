// 配置文件 - 多租户版
// 邮箱配置不再从这里读取，而是从Supabase数据库的 amazon_ads_user_configs 表按租户读取
// 这里只保留系统级配置
module.exports = {
  // Supabase 配置（系统级，所有租户共用同一个数据库）
  supabase: {
    url: process.env.SUPABASE_URL || 'https://tcqohwmdxnlbupancqor.supabase.co',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
  },

  // 邮件筛选条件（所有租户统一）
  filter: {
    sender: process.env.FILTER_SENDER || 'amazon',
    subject: process.env.FILTER_SUBJECT || 'Search term',
    days: parseInt(process.env.FILTER_DAYS || '3'),
  },

  // 数据存储表名
  tableName: process.env.TABLE_NAME || 'amazon_ads_daily_reports',
};
