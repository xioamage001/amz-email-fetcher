const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fetch = require('node-fetch');
const Papa = require('papaparse');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

// 初始化 Supabase 客户端
const supabase = createClient(config.supabase.url, config.supabase.anonKey);

function log(msg) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${time}] ${msg}`);
}

// 连接邮箱并搜索邮件
function searchEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.email.user,
      password: config.email.password,
      host: config.email.host,
      port: config.email.port,
      tls: config.email.tls,
    });

    imap.once('ready', () => {
      log('邮箱连接成功，发送IMAP ID标识...');
      imap.id({
        name: 'amz-email-fetcher',
        version: '1.0',
        vendor: 'amzAI',
        contact: config.email.user
      }, () => {
        log('IMAP ID标识已发送，开始搜索邮件...');
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
                    log('解析邮件失败: ' + err.message);
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
                    log(`找到匹配邮件: ${subject} (${from})`);
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
      log('邮箱连接已关闭');
    });

    imap.connect();
  });
}

// 从邮件HTML中提取下载链接
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

// 从邮件主题提取报告日期
function extractReportDate(subject) {
  const match = subject.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    const month = match[1];
    const day = match[2];
    const year = match[3];
    return `${year}-${month}-${day}`;
  }
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

// 下载CSV文件
async function downloadCSV(url) {
  log('正在下载报告: ' + url.substring(0, 80) + '...');
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    timeout: 60000,
  });

  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status}`);
  }

  const text = await response.text();
  log(`下载成功，文件大小: ${text.length} 字节`);
  return text;
}

// 解析CSV
function parseCSV(csvText) {
  return new Promise((resolve, reject) => {
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors && results.errors.length > 0) {
          log(`CSV解析警告: ${results.errors.length} 个错误`);
        }
        resolve(results.data);
      },
      error: (err) => reject(err),
    });
  });
}

// 存到Supabase
async function saveToSupabase(dateKey, rows, fileName) {
  log(`正在存储数据到Supabase: date=${dateKey}, rows=${rows.length}`);

  const { data: existing, error: queryError } = await supabase
    .from(config.tableName)
    .select('*')
    .eq('user_id', config.supabase.userId)
    .eq('date_key', dateKey)
    .single();

  if (queryError && queryError.code !== 'PGRST116') {
    throw new Error('查询已有数据失败: ' + queryError.message);
  }

  let mergedRows = rows;
  let source = 'email_auto';

  if (existing && existing.rows && existing.rows.length > 0) {
    log(`当天已有 ${existing.rows.length} 行数据，正在合并去重...`);
    const existingMap = new Map();
    existing.rows.forEach(row => {
      const key = `${row['搜索词'] || row['Search term'] || ''}_${row['活动名称'] || row['Campaign Name'] || ''}_${row['广告组'] || row['Ad Group'] || ''}`;
      existingMap.set(key, row);
    });

    rows.forEach(row => {
      const key = `${row['搜索词'] || row['Search term'] || ''}_${row['活动名称'] || row['Campaign Name'] || ''}_${row['广告组'] || row['Ad Group'] || ''}`;
      existingMap.set(key, row);
    });

    mergedRows = Array.from(existingMap.values());
    source = 'email_auto_merged';
    log(`合并后共 ${mergedRows.length} 行数据`);
  }

  const record = {
    user_id: config.supabase.userId,
    date_key: dateKey,
    file_name: fileName,
    rows: mergedRows,
    result: null,
    data_quality: {
      totalRows: mergedRows.length,
      columns: mergedRows.length > 0 ? Object.keys(mergedRows[0]).length : 0,
      source: 'email',
      fetchedAt: new Date().toISOString(),
    },
    source: source,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    record.created_at = existing.created_at;
    const { error: updateError } = await supabase
      .from(config.tableName)
      .update(record)
      .eq('user_id', config.supabase.userId)
      .eq('date_key', dateKey);
    if (updateError) throw new Error('更新数据失败: ' + updateError.message);
  } else {
    record.created_at = new Date().toISOString();
    const { error: insertError } = await supabase
      .from(config.tableName)
      .insert(record);
    if (insertError) throw new Error('插入数据失败: ' + insertError.message);
  }

  log(`数据存储成功: ${dateKey}, 共 ${mergedRows.length} 行`);
  return mergedRows.length;
}

// 处理单封邮件
async function processEmail(email) {
  const dateKey = extractReportDate(email.subject);
  log(`处理邮件: ${email.subject} (报告日期: ${dateKey})`);

  const downloadUrl = extractDownloadLink(email);
  if (!downloadUrl) {
    throw new Error(`未在邮件中找到下载链接: ${email.subject}`);
  }
  log(`找到下载链接: ${downloadUrl.substring(0, 80)}...`);

  const csvText = await downloadCSV(downloadUrl);
  const rows = await parseCSV(csvText);
  log(`CSV解析完成: ${rows.length} 行, ${rows.length > 0 ? Object.keys(rows[0]).length : 0} 列`);

  if (rows.length === 0) {
    throw new Error('CSV解析后无数据');
  }

  const fileName = `Search_term_${dateKey}.csv`;
  const savedRows = await saveToSupabase(dateKey, rows, fileName);

  return { dateKey, rowCount: savedRows, fileName };
}

// 主拉取流程
async function fetchReports() {
  const startTime = new Date();
  log('========== 开始拉取亚马逊搜索词报告 ==========');

  try {
    const emails = await searchEmails();
    log(`共找到 ${emails.length} 封匹配邮件`);

    if (emails.length === 0) {
      return { success: true, emailCount: 0, message: '未找到匹配的报告邮件' };
    }

    const dateMap = new Map();
    emails.forEach(email => {
      const dateKey = extractReportDate(email.subject);
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, email);
      }
    });
    log(`去重后共 ${dateMap.size} 个不同日期的报告`);

    const results = [];
    const errors = [];
    for (const [dateKey, email] of dateMap) {
      try {
        const result = await processEmail(email);
        results.push(result);
      } catch (err) {
        log(`处理 ${dateKey} 失败: ${err.message}`);
        errors.push({ dateKey, error: err.message });
      }
    }

    const duration = ((new Date() - startTime) / 1000).toFixed(1);
    log(`========== 拉取完成，成功 ${results.length} 个，失败 ${errors.length} 个，耗时 ${duration} 秒 ==========`);

    return {
      success: errors.length === 0,
      emailCount: emails.length,
      processed: results.length,
      failed: errors.length,
      results: results,
      errors: errors,
    };

  } catch (error) {
    log('拉取失败: ' + error.message);
    return { success: false, error: error.message };
  }
}

// 主入口
async function main() {
  log('亚马逊广告AI分析助手 - 邮箱自动拉取（GitHub Actions版）');
  log(`邮箱: ${config.email.user}`);
  log(`IMAP: ${config.email.host}:${config.email.port}`);
  log(`Supabase: ${config.supabase.url}`);
  log('----------------------------------------');

  const result = await fetchReports();

  if (!result.success) {
    console.error('::error::拉取失败: ' + (result.error || JSON.stringify(result.errors)));
    process.exit(1);
  }

  console.log('::set-output name=result::' + JSON.stringify(result));
  process.exit(0);
}

main();
