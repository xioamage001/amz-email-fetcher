const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fetch = require('node-fetch');
const Papa = require('papaparse');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.anonKey);

function log(msg) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${time}] ${msg}`);
}

// ========== 多租户：从数据库读取所有启用了邮箱拉取的租户配置 ==========
async function fetchAllTenantEmailConfigs() {
  log('正在从数据库读取所有租户的邮箱配置...');

  // 1. 读取所有租户
  const { data: tenants, error: tenantError } = await supabase
    .from('amazon_ads_tenants')
    .select('id, tenant_code, tenant_name, status');

  if (tenantError) throw new Error('读取租户列表失败: ' + tenantError.message);
  log(`共找到 ${tenants.length} 个租户`);

  // 2. 读取所有用户配置（筛选启用了邮箱拉取且有配置的）
  const { data: configs, error: configError } = await supabase
    .from('amazon_ads_user_configs')
    .select('user_id, email_enabled, email_config')
    .eq('email_enabled', true)
    .not('email_config', 'is', null);

  if (configError) throw new Error('读取邮箱配置失败: ' + configError.message);
  log(`共找到 ${configs.length} 个启用了邮箱拉取的配置`);

  // 3. 关联租户ID，组装成拉取任务列表
  const tasks = [];
  for (const cfg of configs) {
    const tenant = tenants.find(t => t.tenant_code === cfg.user_id);
    if (!tenant) {
      log(`⚠️  配置 user_id=${cfg.user_id} 未找到对应租户，跳过`);
      continue;
    }
    if (tenant.status !== 'active') {
      log(`⚠️  租户 ${tenant.tenant_name} 状态非active，跳过`);
      continue;
    }
    if (!cfg.email_config || !cfg.email_config.email || !cfg.email_config.password) {
      log(`⚠️  租户 ${tenant.tenant_name} 邮箱配置不完整，跳过`);
      continue;
    }
    tasks.push({
      tenantId: tenant.id,
      tenantCode: tenant.tenant_code,
      tenantName: tenant.tenant_name,
      userId: cfg.user_id,
      email: cfg.email_config.email,
      password: cfg.email_config.password,
      host: cfg.email_config.host || 'imap.163.com',
      port: parseInt(cfg.email_config.port || '993'),
      tls: cfg.email_config.tls !== false,
    });
  }

  log(`组装完成，共 ${tasks.length} 个租户需要拉取`);
  tasks.forEach(t => log(`  - ${t.tenantName} (${t.tenantCode}): ${t.email}`));
  return tasks;
}

// ========== 邮箱搜索（按租户配置） ==========
function searchEmails(tenantConfig) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: tenantConfig.email,
      password: tenantConfig.password,
      host: tenantConfig.host,
      port: tenantConfig.port,
      tls: tenantConfig.tls,
      connTimeout: 30000,
      authTimeout: 30000,
    });

    imap.once('ready', () => {
      log(`[${tenantConfig.tenantName}] 邮箱连接成功，发送IMAP ID标识...`);
      imap.id({
        name: 'amz-email-fetcher',
        version: '2.0-multitenant',
        vendor: 'amzAI',
        contact: tenantConfig.email
      }, () => {
        log(`[${tenantConfig.tenantName}] IMAP ID标识已发送，开始搜索邮件...`);
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            imap.end();
            return reject(new Error('打开收件箱失败: ' + err.message));
          }

          const sinceDate = new Date();
          sinceDate.setDate(sinceDate.getDate() - config.filter.days);
          const sinceStr = sinceDate.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

          imap.search([['SINCE', sinceStr]], (err, uids) => {
            if (err) {
              imap.end();
              return reject(new Error('搜索邮件失败: ' + err.message));
            }

            if (!uids || uids.length === 0) {
              imap.end();
              return resolve([]);
            }

            const f = imap.fetch(uids, { bodies: '', struct: true });
            const emails = [];
            let pending = 0;
            let done = false;

            f.on('message', (msg, seqno) => {
              pending++;
              msg.on('body', (stream, info) => {
                simpleParser(stream, async (err, parsed) => {
                  if (err) {
                    log(`[${tenantConfig.tenantName}] 解析邮件失败: ` + err.message);
                    pending--;
                    if (pending === 0 && done) finish();
                    return;
                  }

                  const from = (parsed.from && parsed.from.text) || '';
                  const subject = parsed.subject || '';
                  const date = parsed.date || new Date();
                  const html = parsed.html || '';
                  const text = parsed.text || '';

                  if (from.toLowerCase().includes(config.filter.sender.toLowerCase()) &&
                      subject.toLowerCase().includes(config.filter.subject.toLowerCase())) {
                    log(`[${tenantConfig.tenantName}] 找到匹配邮件: ${subject} (${from})`);
                    emails.push({ from, subject, date, html, text });
                  }

                  pending--;
                  if (pending === 0 && done) finish();
                });
              });
            });

            f.once('error', (err) => {
              imap.end();
              reject(new Error('获取邮件失败: ' + err.message));
            });

            f.once('end', () => {
              done = true;
              if (pending === 0) finish();
            });

            function finish() {
              imap.end();
              emails.sort((a, b) => b.date - a.date);
              resolve(emails);
            }
          });
        });
      });
    });

    imap.once('error', (err) => {
      reject(new Error('邮箱连接失败: ' + err.message));
    });

    imap.once('end', () => {
      log(`[${tenantConfig.tenantName}] 邮箱连接已关闭`);
    });

    imap.connect();
  });
}

function extractDownloadLink(email) {
  const $ = cheerio.load(email.html);
  let link = null;
  $('a').each((i, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href');
    if (href && (text.includes('下载') || text.includes('Download') || text.includes('报告') || text.includes('report'))) {
      link = href;
      return false;
    }
  });
  if (!link) {
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('amazon') || href.includes('aws') || href.includes('s3')) {
        link = href;
        return false;
      }
    });
  }
  if (!link && email.text) {
    const urlMatch = email.text.match(/https?:\/\/[^\s<>"']+/);
    if (urlMatch) link = urlMatch[0];
  }
  return link;
}

function extractReportDate(subject) {
  const match = subject.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[1]}-${match[2]}`;
  }
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

async function downloadCSV(url) {
  log('正在下载报告: ' + url.substring(0, 80) + '...');
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 60000,
  });
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
  const text = await response.text();
  log(`下载成功，文件大小: ${text.length} 字节`);
  return text;
}

function parseCSV(csvText) {
  return new Promise((resolve, reject) => {
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

// ========== 存储到Supabase（按租户隔离） ==========
async function saveToSupabase(tenantConfig, dateKey, rows, fileName) {
  log(`[${tenantConfig.tenantName}] 正在存储数据: date=${dateKey}, rows=${rows.length}`);

  const { data: existing, error: queryError } = await supabase
    .from(config.tableName)
    .select('*')
    .eq('tenant_id', tenantConfig.tenantId)
    .eq('date_key', dateKey)
    .single();

  if (queryError && queryError.code !== 'PGRST116') {
    throw new Error('查询已有数据失败: ' + queryError.message);
  }

  let mergedRows = rows;
  let source = 'email_auto';

  if (existing && existing.raw_data && existing.raw_data.length > 0) {
    log(`[${tenantConfig.tenantName}] 当天已有 ${existing.raw_data.length} 行数据，正在合并去重...`);
    const existingMap = new Map();
    existing.raw_data.forEach(row => {
      const key = `${row['搜索词'] || row['Search term'] || ''}_${row['活动名称'] || row['Campaign Name'] || ''}_${row['广告组'] || row['Ad Group'] || ''}`;
      existingMap.set(key, row);
    });
    rows.forEach(row => {
      const key = `${row['搜索词'] || row['Search term'] || ''}_${row['活动名称'] || row['Campaign Name'] || ''}_${row['广告组'] || row['Ad Group'] || ''}`;
      existingMap.set(key, row);
    });
    mergedRows = Array.from(existingMap.values());
    source = 'email_auto_merged';
    log(`[${tenantConfig.tenantName}] 合并后共 ${mergedRows.length} 行数据`);
  }

  // 计算汇总指标
  let totalSpend = 0, totalClicks = 0, totalOrders = 0, totalSales = 0;
  mergedRows.forEach(row => {
    totalSpend += parseFloat(row['总成本（已转换）'] || row['总成本'] || row['Spend'] || 0);
    totalClicks += parseInt(row['点击量'] || row['Clicks'] || 0);
    totalOrders += parseInt(row['归因于点击的购买量'] || row['Orders'] || 0);
    totalSales += parseFloat(row['归因于点击的销售额（已换算）'] || row['销售额'] || row['Sales'] || 0);
  });

  const record = {
    tenant_id: tenantConfig.tenantId,
    user_id: tenantConfig.userId,
    date_key: dateKey,
    file_name: fileName,
    source: source,
    total_rows: mergedRows.length,
    total_columns: mergedRows.length > 0 ? Object.keys(mergedRows[0]).length : 0,
    raw_data: mergedRows,
    summary: {
      spend: Math.round(totalSpend * 100) / 100,
      clicks: totalClicks,
      orders: totalOrders,
      sales: Math.round(totalSales * 100) / 100,
      acos: totalSales > 0 ? Math.round(totalSpend / totalSales * 1000) / 10 : 0,
      cvr: totalClicks > 0 ? Math.round(totalOrders / totalClicks * 1000) / 10 : 0,
    },
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error: updateError } = await supabase
      .from(config.tableName)
      .update(record)
      .eq('tenant_id', tenantConfig.tenantId)
      .eq('date_key', dateKey);
    if (updateError) throw new Error('更新数据失败: ' + updateError.message);
  } else {
    record.created_at = new Date().toISOString();
    const { error: insertError } = await supabase
      .from(config.tableName)
      .insert(record);
    if (insertError) throw new Error('插入数据失败: ' + insertError.message);
  }

  log(`[${tenantConfig.tenantName}] 数据存储成功: ${dateKey}, 共 ${mergedRows.length} 行`);
  return mergedRows.length;
}

async function processEmail(tenantConfig, email) {
  const dateKey = extractReportDate(email.subject);
  log(`[${tenantConfig.tenantName}] 处理邮件: ${email.subject} (报告日期: ${dateKey})`);

  const downloadUrl = extractDownloadLink(email);
  if (!downloadUrl) throw new Error(`未找到下载链接: ${email.subject}`);

  const csvText = await downloadCSV(downloadUrl);
  const rows = await parseCSV(csvText);
  log(`[${tenantConfig.tenantName}] CSV解析完成: ${rows.length} 行, ${rows.length > 0 ? Object.keys(rows[0]).length : 0} 列`);
  if (rows.length === 0) throw new Error('CSV解析后无数据');

  const fileName = `Search_term_${dateKey}.csv`;
  return await saveToSupabase(tenantConfig, dateKey, rows, fileName);
}

// ========== 单个租户的拉取流程 ==========
async function fetchReportsForTenant(tenantConfig) {
  log(`========== 开始拉取租户 [${tenantConfig.tenantName}] 的报告 ==========`);
  try {
    const emails = await searchEmails(tenantConfig);
    log(`[${tenantConfig.tenantName}] 共找到 ${emails.length} 封匹配邮件`);

    if (emails.length === 0) {
      return { success: true, tenant: tenantConfig.tenantName, emailCount: 0, message: '未找到匹配的报告邮件' };
    }

    const dateMap = new Map();
    emails.forEach(email => {
      const dateKey = extractReportDate(email.subject);
      if (!dateMap.has(dateKey)) dateMap.set(dateKey, email);
    });
    log(`[${tenantConfig.tenantName}] 去重后共 ${dateMap.size} 个不同日期的报告`);

    const results = [];
    const errors = [];
    for (const [dateKey, email] of dateMap) {
      try {
        const rowCount = await processEmail(tenantConfig, email);
        results.push({ dateKey, rowCount });
      } catch (err) {
        log(`[${tenantConfig.tenantName}] 处理 ${dateKey} 失败: ${err.message}`);
        errors.push({ dateKey, error: err.message });
      }
    }

    return {
      success: errors.length === 0,
      tenant: tenantConfig.tenantName,
      emailCount: emails.length,
      processed: results.length,
      failed: errors.length,
      results,
      errors,
    };
  } catch (error) {
    log(`[${tenantConfig.tenantName}] 拉取失败: ${error.message}`);
    return { success: false, tenant: tenantConfig.tenantName, error: error.message };
  }
}

// ========== 主流程：多租户循环拉取 ==========
async function main() {
  const startTime = new Date();
  log('==================================================');
  log('亚马逊广告AI分析助手 - 多租户邮箱自动拉取服务 v3.0');
  log(`Supabase: ${config.supabase.url}`);
  log(`数据表: ${config.tableName}`);
  log(`邮件筛选: 发件人含"${config.filter.sender}", 主题含"${config.filter.subject}", 最近${config.filter.days}天`);
  log('==================================================');

  try {
    // 1. 读取所有租户的邮箱配置
    const tenantTasks = await fetchAllTenantEmailConfigs();

    if (tenantTasks.length === 0) {
      log('没有租户启用邮箱拉取，任务结束');
      console.log('::set-output name=result::' + JSON.stringify({ success: true, message: '没有启用邮箱拉取的租户' }));
      process.exit(0);
    }

    // 2. 循环每个租户拉取
    const allResults = [];
    let totalSuccess = 0;
    let totalFailed = 0;

    for (const tenantConfig of tenantTasks) {
      log('');
      const result = await fetchReportsForTenant(tenantConfig);
      allResults.push(result);
      if (result.success) totalSuccess++;
      else totalFailed++;
      // 租户之间间隔2秒，避免IMAP连接过于频繁
      if (tenantTasks.indexOf(tenantConfig) < tenantTasks.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const duration = ((new Date() - startTime) / 1000).toFixed(1);
    log('');
    log('==================================================');
    log(`全部拉取完成: 成功 ${totalSuccess}/${tenantTasks.length} 个租户, 失败 ${totalFailed} 个, 总耗时 ${duration} 秒`);
    allResults.forEach(r => {
      const status = r.success ? '✅' : '❌';
      log(`  ${status} ${r.tenant}: ${r.success ? `处理${r.processed}个报告` : r.error || `${r.failed}个失败`}`);
    });
    log('==================================================');

    const finalResult = {
      success: totalFailed === 0,
      totalTenants: tenantTasks.length,
      successCount: totalSuccess,
      failedCount: totalFailed,
      duration: duration + 's',
      results: allResults,
    };

    console.log('::set-output name=result::' + JSON.stringify(finalResult));

    if (totalFailed > 0) {
      console.error('::warning::部分租户拉取失败，请查看日志详情');
    }
    process.exit(0);
  } catch (error) {
    log('致命错误: ' + error.message);
    console.error('::error::拉取失败: ' + error.message);
    process.exit(1);
  }
}

main();
